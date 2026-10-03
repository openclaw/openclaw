import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import * as systemctl from "../daemon/systemd-exec.js";
import * as lifecycle from "../daemon/systemd-lifecycle.js";
import * as systemd from "../daemon/systemd-service-files.js";
import * as identity from "../daemon/systemd-service-identity.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";
import {
  assertImmutableServiceProcessCurrent,
  assertImmutableServiceStoppedCurrent,
  inspectImmutableActivationService,
  startImmutableService,
  stopImmutableService,
  verifyImmutableService,
} from "./update-immutable-service.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => fsSync.readFileSync(...args),
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let generation: string;
let node: string;
let service: ImmutableInstallDescriptor["service"];

beforeEach(async () => {
  const home = dirs.make("immutable-service-");
  root = path.join(home, "install");
  generation = path.join(root, "releases", "a".repeat(40));
  node = path.join(home, "node");
  await fs.mkdir(path.join(generation, "dist"), { recursive: true });
  await fs.writeFile(path.join(generation, "dist", "index.js"), "");
  await fs.writeFile(node, "");
  await fs.symlink(generation, path.join(root, "current"));
  service = {
    unit: "example.service",
    scope: "system",
    account: "openclaw",
    stateDir: "/var/lib/example",
    configPath: "/etc/example/openclaw.json",
    profile: null,
  };
  const command = {
    programArguments: [node, path.join(root, "current", "dist", "index.js"), "gateway"],
    sourcePath: "/etc/systemd/system/example.service",
    environment: {
      OPENCLAW_STATE_DIR: service.stateDir,
      OPENCLAW_CONFIG_PATH: service.configPath,
    },
  };
  vi.spyOn(systemd, "readSystemdServiceCommandLocation").mockResolvedValue({
    kind: "command",
    command,
  });
  vi.spyOn(systemd, "readSystemdServiceExecStartAsRoot").mockResolvedValue(command);
  vi.spyOn(systemctl, "execSystemctl").mockResolvedValue({
    code: 0,
    termination: "exit",
    stdout:
      "Id=example.service\nLoadState=loaded\nActiveState=active\nDynamicUser=no\nRootDirectory=\nRootImage=\n",
    stderr: "",
  });
});
afterEach(() => vi.restoreAllMocks());

it("binds the effective service to the physical current generation and explicit state", async () => {
  await expect(verifyImmutableService(service, root, generation, node)).resolves.toBeUndefined();
  expect(systemd.readSystemdServiceExecStartAsRoot).toHaveBeenCalledWith(
    { OPENCLAW_SYSTEMD_UNIT: "example.service" },
    {
      scope: "system",
      unitName: "example.service",
      unitPath: "/etc/systemd/system/example.service",
    },
    "openclaw",
  );
});

it.each(["stateDir", "configPath", "profile"] as const)(
  "refuses adoption when the supplied %s does not match the effective service",
  async (key) => {
    service[key] = key === "profile" ? "other" : "/unrelated";
    await expect(verifyImmutableService(service, root, generation, node)).rejects.toThrow(
      "effective environment",
    );
  },
);

it("refuses a current symlink redirected to another generation", async () => {
  const other = path.join(root, "releases", "b".repeat(40));
  await fs.mkdir(path.join(other, "dist"), { recursive: true });
  await fs.writeFile(path.join(other, "dist", "index.js"), "");
  await fs.unlink(path.join(root, "current"));
  await fs.symlink(other, path.join(root, "current"));
  await expect(verifyImmutableService(service, root, generation, node)).rejects.toThrow(
    "current immutable generation",
  );
});

// Native manager mutation is covered by systemd-service-identity.test; this fixture
// exercises the immutable generation, process and preservation boundary above it.

vi.mock("../daemon/service-operation-lock.js", () => ({
  withGatewayServiceOperationLock: async (
    _env: unknown,
    operation: (assertCurrent: () => void) => Promise<unknown>,
  ) => operation(() => {}),
}));

describe("immutable activation service", () => {
  let descriptor: ImmutableInstallDescriptor;
  let command: GatewayServiceCommandConfig;
  let alive: boolean;
  let activating: boolean;
  let launcherPending: boolean;
  let currentPid: number;
  let ticks: number;
  let callerInside: boolean;
  let processGeneration: string;
  let currentRuntime: string;
  let populated: boolean;
  let cgroupReads: number;
  let pendingJob: number;
  let stopEffect: (() => void) | undefined;
  const controlGroup = "/system.slice/example.service";
  const pid = 43210;
  const assertCurrent = () => {};
  const inspect = (allowStopped = false) =>
    inspectImmutableActivationService({
      descriptor,
      generationPath: generation,
      allowStopped,
      assertCurrent,
    });

  beforeEach(async () => {
    mockProcessPlatform("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    alive = true;
    activating = false;
    launcherPending = false;
    currentPid = pid;
    ticks = 101;
    callerInside = false;
    processGeneration = generation;
    currentRuntime = node;
    populated = true;
    cgroupReads = 0;
    pendingJob = 0;
    stopEffect = undefined;
    const sourcePath = path.join(root, "example.service");
    await fs.writeFile(sourcePath, "[Service]\nUser=openclaw\nProtectSystem=strict\n");
    const launcher = path.join(root, "bin", "openclaw-gateway");
    await fs.mkdir(path.dirname(launcher));
    await fs.writeFile(launcher, `#!${node}\n// Synthetic packaged launcher.\n`);
    command = {
      programArguments: [launcher],
      sourcePath,
      environment: {
        OPENCLAW_STATE_DIR: service.stateDir,
        OPENCLAW_CONFIG_PATH: service.configPath,
      },
    };
    vi.mocked(systemd.readSystemdServiceCommandLocation).mockImplementation(async () => ({
      kind: "command",
      command,
    }));
    vi.mocked(systemd.readSystemdServiceExecStartAsRoot).mockImplementation(async () => command);
    vi.mocked(systemctl.execSystemctl).mockImplementation(async () => ({
      code: 0,
      termination: "exit",
      stderr: "",
      stdout: `Id=example.service\nLoadState=loaded\nActiveState=${activating ? "activating" : alive ? "active" : "inactive"}\nSubState=${alive ? "running" : "dead"}\nMainPID=${alive ? currentPid : 0}\nControlGroup=${controlGroup}\nTasksCurrent=${populated ? 1 : 0}\nKillMode=control-group\nDynamicUser=no\nRootDirectory=\nRootImage=\nJob=${pendingJob}\n`,
    }));
    const read = fsSync.readFileSync;
    vi.spyOn(fsSync, "readFileSync").mockImplementation((file, ...args) => {
      if ([pid, currentPid].some((candidate) => String(file) === `/proc/${candidate}/stat`)) {
        if (!alive) {
          throw Object.assign(new Error("exited"), { code: "ENOENT" });
        }
        return `${pid} (openclaw-gateway) S ${"0 ".repeat(18)}${ticks}`;
      }
      if ([pid, currentPid].some((candidate) => String(file) === `/proc/${candidate}/cgroup`)) {
        return `0::${controlGroup}\n`;
      }
      if (String(file) === `/proc/${pid}/cmdline`) {
        return launcherPending
          ? [node, ...command.programArguments, ""].join("\0")
          : "openclaw-gateway\0";
      }
      if (String(file) === `/proc/${process.pid}/cgroup`) {
        return `0::${callerInside ? controlGroup : "/user.slice/updater.scope"}\n`;
      }
      if (String(file) === `/sys/fs/cgroup${controlGroup}/cgroup.events`) {
        cgroupReads++;
        return `populated ${populated ? 1 : 0}\nfrozen 0\n`;
      }
      return read(file, ...args);
    });
    const readlink = fsSync.readlinkSync;
    vi.spyOn(fsSync, "readlinkSync").mockImplementation((file, ...args) => {
      if ([pid, currentPid].some((candidate) => String(file) === `/proc/${candidate}/exe`)) {
        return currentRuntime;
      }
      if ([pid, currentPid].some((candidate) => String(file) === `/proc/${candidate}/cwd`)) {
        return processGeneration;
      }
      return readlink(file, ...args);
    });
    const native = {
      scope: "system" as const,
      unitName: service.unit,
      unitPath: sourcePath,
      bus: { address: "unix:path=/synthetic/system-bus" },
      busId: "d".repeat(32),
      managerOwner: ":1.2",
      managerUid: 0,
      serviceUser: service.account,
      rootServiceAccount: service.account,
    };
    vi.spyOn(identity, "captureSystemdServiceIdentity").mockResolvedValue(native);
    vi.spyOn(lifecycle, "stopSystemdService").mockImplementation(async (args) => {
      await args.beforeMutation?.();
      await args.prepareEffect?.();
      stopEffect?.();
      args.beforeEffect?.();
      args.assertCurrent?.();
      alive = false;
      populated = false;
      args.assertCurrent?.();
    });
    vi.spyOn(lifecycle, "startSystemdService").mockImplementation(async (args) => {
      await args.beforeMutation?.();
      args.beforeEffect?.();
      args.assertCurrent?.();
      alive = true;
      populated = true;
      args.assertCurrent?.();
    });
    descriptor = {
      version: 2,
      activationEnabled: true,
      kind: "immutable",
      root,
      rootIdentity: "1:1",
      releasesIdentity: "1:2",
      current: {
        sha: "a".repeat(40),
        path: generation,
        identity: "1:3",
        pointerIdentity: "1:4",
        buildDigest: "a".repeat(64),
      },
      service,
      runtime: { path: node, identity: "synthetic" },
      source: "https://github.com/openclaw/openclaw.git",
    };
  });

  it("binds the live process to its physical generation, external runtime and stable service", async () => {
    const observed = await inspect();
    expect(observed).toMatchObject({
      pid,
      processStartTicks: "101",
      generationPath: generation,
      state: { running: true },
    });
    expect(observed.definitionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => assertImmutableServiceProcessCurrent(observed)).not.toThrow();
  });

  it.each(["stopped", "auto-restart", "queued job", "replacement"] as const)(
    "reconciles a host that becomes %s after committing shutdown before native dispatch",
    async (outcome) => {
      const expected = await inspect();
      const stopping = stopImmutableService({
        descriptor,
        expected,
        assertCurrent,
        stdout: new PassThrough(),
        prepareEffect: async () => {
          alive = false;
          populated = false;
          if (outcome === "auto-restart") {
            activating = true;
          } else if (outcome === "queued job") {
            pendingJob = 7;
          } else if (outcome === "replacement") {
            alive = true;
            populated = true;
            currentPid++;
            ticks++;
          }
        },
      });
      if (outcome === "stopped") {
        await expect(stopping).resolves.toBeUndefined();
      } else {
        await expect(stopping).rejects.toThrow();
      }
      expect(alive).toBe(outcome === "replacement");
      expect(populated).toBe(outcome === "replacement");
    },
  );

  it("retains an uncertain native stop even when the service is observed stopped", async () => {
    const expected = await inspect();
    const failure = new Error("native stop reply was lost");
    vi.mocked(lifecycle.stopSystemdService).mockImplementationOnce(async (args) => {
      await args.beforeMutation?.();
      args.beforeEffect?.();
      alive = false;
      populated = false;
      throw failure;
    });
    await expect(
      stopImmutableService({ descriptor, expected, assertCurrent, stdout: new PassThrough() }),
    ).rejects.toBe(failure);
  });

  it.each(["current", "physical"])(
    "permits %s direct-entry adoption but refuses activation before effects",
    async (entry) => {
      command.programArguments = [
        node,
        path.join(
          entry === "current" ? path.join(root, "current") : generation,
          "dist",
          "index.js",
        ),
        "gateway",
      ];
      command.workingDirectory = generation;
      await expect(
        verifyImmutableService(service, root, generation, node),
      ).resolves.toBeUndefined();
      await expect(inspect()).rejects.toThrow("packaged stable Gateway launcher");
      expect(lifecycle.stopSystemdService).not.toHaveBeenCalled();
      expect(lifecycle.startSystemdService).not.toHaveBeenCalled();
    },
  );

  it("observes an acknowledged start with no PID without granting stopped-service authority", async () => {
    alive = false;
    activating = true;
    populated = false;
    const observed = await inspectImmutableActivationService({
      descriptor,
      generationPath: generation,
      allowStarting: true,
      assertCurrent,
    });
    expect(observed).toMatchObject({
      phase: "starting",
      pid: null,
      state: { running: false, runtime: { status: "starting" } },
    });
    await expect(inspect(true)).rejects.toThrow("running systemd service");
    for (const operation of [startImmutableService, stopImmutableService]) {
      await expect(
        operation({ descriptor, expected: observed, assertCurrent, stdout: new PassThrough() }),
      ).rejects.toThrow("start requires a stopped service");
    }
    expect(lifecycle.startSystemdService).not.toHaveBeenCalled();
    expect(lifecycle.stopSystemdService).not.toHaveBeenCalled();
  });

  it.each(["active", "activating"])(
    "waits for the exact stable launcher to execve from its inherited cwd (%s)",
    async (state) => {
      activating = state === "activating";
      processGeneration = root;
      launcherPending = true;
      const observed = await inspectImmutableActivationService({
        descriptor,
        generationPath: generation,
        allowStarting: true,
        assertCurrent,
      });
      expect(observed).toMatchObject({ phase: "starting", pid, state: { running: false } });
      expect(() => assertImmutableServiceProcessCurrent(observed)).toThrow("not running");
      launcherPending = false;
      await expect(
        inspectImmutableActivationService({
          descriptor,
          generationPath: generation,
          allowStarting: true,
          assertCurrent,
        }),
      ).rejects.toThrow("physical generation");
      processGeneration = generation;
      activating = false;
      await expect(inspect()).resolves.toMatchObject({ phase: "running", pid });
    },
  );

  it.each(["generation", "runtime", "caller"])(
    "refuses the wrong %s before any native effect",
    async (changed) => {
      if (changed === "generation") {
        processGeneration = `${generation}-other`;
      }
      if (changed === "runtime") {
        currentRuntime = `${node}-other`;
      }
      if (changed === "caller") {
        callerInside = true;
      }
      await expect(inspect()).rejects.toThrow(
        changed === "caller" ? "outside" : "physical generation",
      );
      expect(lifecycle.stopSystemdService).not.toHaveBeenCalled();
    },
  );

  it("loads a stopped unit only for root-owned inspection and starts through the native owner", async () => {
    alive = false;
    populated = false;
    vi.mocked(systemd.readSystemdServiceCommandLocation).mockResolvedValue({ kind: "not-loaded" });
    const observed = await inspect(true);
    expect(observed).toMatchObject({ pid: null, state: { running: false } });
    expect(systemd.readSystemdServiceExecStartAsRoot).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      service.account,
      { managerUid: 0, assertCurrent },
    );
    await startImmutableService({
      descriptor,
      expected: observed,
      assertCurrent,
      stdout: new PassThrough(),
    });
    expect(alive).toBe(true);
  });

  it.each(["policy", "environment", "launcher", "pid"])(
    "refuses changed %s before stop",
    async (changed) => {
      const observed = await inspect();
      if (changed === "policy") {
        await fs.appendFile(command.sourcePath!, "NoNewPrivileges=yes\n");
      }
      if (changed === "launcher") {
        await fs.appendFile(
          path.join(root, "bin", "openclaw-gateway"),
          "// changed launcher bytes\n",
        );
      }
      if (changed === "environment") {
        command.environment!.OPERATOR_SETTING = "changed";
      }
      if (changed === "pid") {
        currentPid++;
      }
      await expect(
        stopImmutableService({
          descriptor,
          expected: observed,
          assertCurrent,
          stdout: new PassThrough(),
        }),
      ).rejects.toThrow("changed before the native operation");
      expect(alive).toBe(true);
    },
  );

  it("rejects PID reuse at the final synchronous stop boundary", async () => {
    const observed = await inspect();
    stopEffect = () => {
      ticks++;
    };
    await expect(
      stopImmutableService({
        descriptor,
        expected: observed,
        assertCurrent,
        stdout: new PassThrough(),
      }),
    ).rejects.toThrow("changed after inspection");
    expect(alive).toBe(true);
  });

  it("keeps preparation-only adoption unable to stop a serving Gateway", async () => {
    const observed = await inspect();
    descriptor.version = 1;
    delete descriptor.activationEnabled;
    await expect(
      stopImmutableService({
        descriptor,
        expected: observed,
        assertCurrent,
        stdout: new PassThrough(),
      }),
    ).rejects.toThrow("explicitly enabled adoption");
    expect(lifecycle.stopSystemdService).not.toHaveBeenCalled();
    expect(alive).toBe(true);
  });

  it("joins the old process and proves the entire service cgroup empty after native stop", async () => {
    const observed = await inspect();
    const initialReads = cgroupReads;
    await stopImmutableService({
      descriptor,
      expected: observed,
      assertCurrent,
      stdout: new PassThrough(),
    });
    expect(alive).toBe(false);
    expect(cgroupReads).toBeGreaterThan(initialReads);
    await expect(inspect(true)).resolves.toMatchObject({ pid: null, state: { running: false } });
  });

  it("rechecks cgroup descendants synchronously immediately before pointer publication", async () => {
    const observed = await inspect();
    await stopImmutableService({
      descriptor,
      expected: observed,
      assertCurrent,
      stdout: new PassThrough(),
    });
    expect(() => assertImmutableServiceStoppedCurrent(observed)).not.toThrow();
    populated = true;
    expect(() => assertImmutableServiceStoppedCurrent(observed)).toThrow("cgroup is populated");
  });

  it("refuses pointer publication while the original process survives outside an empty cgroup", async () => {
    const observed = await inspect();
    populated = false;
    expect(() => assertImmutableServiceStoppedCurrent(observed)).toThrow("still alive");
  });

  it("refuses stopped recovery while descendant processes remain", async () => {
    alive = false;
    await expect(inspect(true)).rejects.toThrow("still has processes");
    expect(lifecycle.startSystemdService).not.toHaveBeenCalled();
  });
});

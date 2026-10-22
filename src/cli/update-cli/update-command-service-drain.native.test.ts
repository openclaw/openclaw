import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import type { openSystemdBroker } from "../../daemon/systemd-peer-native.js";
import type { CallGatewayCliOptions } from "../../gateway/call.js";
import {
  armGatewaySuspendHandoff,
  consumeGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { inspectors } from "../../infra/gateway-suspend-coordinator.test-support.js";
import type { ImmutableInstallDescriptor } from "../../infra/update-immutable-install-schema.js";
import {
  controlImmutableService,
  inspectImmutableActivationService,
} from "../../infra/update-immutable-service.js";
import {
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createGatewayHostLifecycle } from "../gateway-cli/host-lifecycle.js";
import { withGatewayMaintenanceDrain } from "./update-command-service-drain.js";
import { gatewayHello, nativeResult } from "./update-command-service-fixtures.test-support.js";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  openBroker: vi.fn(),
  command: vi.fn(),
  location: vi.fn(),
  systemctl: vi.fn(),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => fs.readFileSync(...args),
  };
});
vi.mock("../../gateway/call.js", () => ({ callGatewayCli: mocks.call }));
vi.mock("../../daemon/systemd-peer-native.js", () => ({
  openSystemdBroker: mocks.openBroker,
  openSystemdMachineBroker: mocks.openBroker,
}));
vi.mock("../../daemon/systemd-service-files.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-service-files.js")>()),
  readSystemdServiceCommandLocation: mocks.location,
  readSystemdServiceExecStartAsRoot: mocks.command,
}));
vi.mock("../../daemon/systemd-exec.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-exec.js")>()),
  execSystemctl: mocks.systemctl,
  execSystemctlUser: mocks.systemctl,
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({
    config: { gateway: { auth: { mode: "none" } } },
    auth: {},
  }),
}));
vi.mock("./update-command-service-plan.js", () => ({
  resolveUpdatedGatewayRestartPort: async () => 18789,
}));
vi.mock("../../gateway/local-http-probe.js", () => ({
  createConfiguredGatewayLocalProbe: () => ({
    resolveWebSocketTarget: async () => ({ url: "ws://127.0.0.1:18789" }),
  }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const pid = 43210;
const controlGroup = "/system.slice/immutable-native-fixture.service";
let root: string;
let descriptor: ImmutableInstallDescriptor;
let host: ReturnType<typeof createGatewayHostLifecycle>;
const assertCurrent = () => {};

function runtimeFixture() {
  const hooks: Partial<
    Record<"atNativeInspection" | "beforeDispatch" | "beforeHandoffDispatch", () => void>
  > = {};
  return {
    alive: true,
    processTicks: 101,
    shutdownCommitted: false,
    loseCommittedReply: false,
    epoch: 1_800_000_000_000,
    monotonic: 1_000,
    ordinaryWork: 0,
    persistence: 0,
    bootId: "original-boot",
    suspensionId: "",
    events: new Array<string>(),
    assertProtection: () => {},
    ...hooks,
  };
}
let f = runtimeFixture();

function params(request: CallGatewayCliOptions): Record<string, unknown> {
  if (!isRecord(request.params)) {
    throw new Error(`Missing fixture RPC params for ${request.method}`);
  }
  return request.params;
}

function stringParam(request: CallGatewayCliOptions, name: string) {
  const value = params(request)[name];
  if (typeof value !== "string") {
    throw new Error(`Missing fixture ${name}`);
  }
  return value;
}

function expectCommittedAdmission() {
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(getGatewaySuspendStatus(f.suspensionId, true)).toMatchObject({
    status: "draining",
    phase: "interrupting",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
  root = fs.realpathSync(dirs.make("immutable-native-drain-"));
  installPrivateUpdateHandoffStore(root);
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  f = runtimeFixture();
  host = createGatewayHostLifecycle({
    isCurrent: () => true,
    isServing: () => f.alive && !f.shutdownCommitted,
    acceptStop: () => {
      throw new Error("Immutable handoff must not use privileged hosted stop");
    },
    commitExternalStop: () => {
      const consumed = consumeGatewaySuspendHandoff(host.capability.externalRestart);
      if (!consumed.ok || !consumed.value) {
        throw new Error("Host did not consume its exact suspension");
      }
      markGatewayRestartDraining("stop (SIGTERM)");
      f.shutdownCommitted = true;
      f.events.push("host:committed");
    },
    processOwner: { ownsProcessLifecycle: true, supervisor: "systemd" },
  });
  vi.spyOn(Date, "now").mockImplementation(() => f.epoch);
  vi.spyOn(performance, "now").mockImplementation(() => f.monotonic);
  const sha = "a".repeat(40);
  const generation = path.join(root, "releases", sha);
  fs.mkdirSync(path.join(generation, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(generation, "dist", "index.js"), "// fixture runtime\n");
  const runtime = path.join(root, "node");
  fs.writeFileSync(runtime, "fixture external runtime");
  const launcher = path.join(root, "bin", "openclaw-gateway");
  fs.writeFileSync(launcher, `#!${runtime}\n// fixture launcher\n`);
  fs.symlinkSync(`releases/${sha}`, path.join(root, "current"));
  const sourcePath = path.join(root, "immutable-native-fixture.service");
  fs.writeFileSync(sourcePath, "[Service]\nUser=synthetic-gateway\nKillMode=control-group\n");
  descriptor = {
    version: 2,
    activationEnabled: true,
    kind: "immutable",
    root,
    rootIdentity: "1:1",
    releasesIdentity: "1:2",
    current: {
      sha,
      path: generation,
      identity: "1:3",
      pointerIdentity: "1:4",
      buildDigest: "a".repeat(64),
    },
    service: {
      unit: "immutable-native-fixture.service",
      scope: "system",
      account: "synthetic-gateway",
      stateDir: path.join(root, "state"),
      configPath: path.join(root, "openclaw.json"),
      profile: null,
    },
    runtime: { path: runtime, identity: "1:5" },
    source: "https://github.com/openclaw/openclaw.git",
  };
  const command: GatewayServiceCommandConfig = {
    programArguments: [launcher],
    sourcePath,
    environment: {
      OPENCLAW_STATE_DIR: descriptor.service.stateDir,
      OPENCLAW_CONFIG_PATH: descriptor.service.configPath,
    },
  };
  mocks.location.mockImplementation(async () => ({ kind: "command", command }));
  mocks.command.mockImplementation(async () => command);
  mocks.systemctl.mockImplementation(async () =>
    nativeResult(
      `Id=${descriptor.service.unit}\nLoadState=loaded\nActiveState=${f.alive ? "active" : "inactive"}\nSubState=${f.alive ? "running" : "dead"}\nMainPID=${f.alive ? pid : 0}\nControlGroup=${controlGroup}\nTasksCurrent=${f.alive ? 1 : 0}\nJob=0\nKillMode=control-group\nTimeoutStopUSec=330s\nDynamicUser=no\nRootDirectory=\nRootImage=\n`,
    ),
  );
  const readFile = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) => {
    if (String(file) === `/proc/${pid}/stat`) {
      if (!f.alive) {
        throw Object.assign(new Error("fixture process exited"), { code: "ENOENT" });
      }
      return `${pid} (openclaw-gateway) S ${"0 ".repeat(18)}${f.processTicks}`;
    }
    if (String(file) === `/proc/${pid}/cgroup`) {
      return `0::${controlGroup}\n`;
    }
    if (String(file) === `/proc/${process.pid}/cgroup`) {
      return "0::/user.slice/immutable-updater.scope\n";
    }
    if (String(file) === `/sys/fs/cgroup${controlGroup}/cgroup.events`) {
      f.events.push(f.alive ? "cgroup:populated" : "cgroup:empty");
      return `populated ${f.alive ? 1 : 0}\nfrozen 0\n`;
    }
    return readFile(file, ...args);
  });
  const readlink = fs.readlinkSync;
  vi.spyOn(fs, "readlinkSync").mockImplementation((file, ...args) => {
    if (String(file) === `/proc/${pid}/exe`) {
      return runtime;
    }
    if (String(file) === `/proc/${pid}/cwd`) {
      return generation;
    }
    return readlink(file, ...args);
  });
  mocks.call.mockImplementation(async (request: CallGatewayCliOptions) => {
    request.onHelloOk?.(gatewayHello(f.bootId));
    if (request.method === "gateway.suspend.handoff") {
      await Promise.resolve();
      f.beforeHandoffDispatch?.();
    }
    request.assertDispatchCurrent?.();
    f.events.push(`rpc:${request.method}`);
    if (request.method === "status") {
      return { pid, shutdownBudget: { timeoutMs: 325_000 } };
    }
    if (request.method === "system.info") {
      return { pid, processInstanceId: "original-process-instance" };
    }
    if (request.method === "gateway.suspend.prepare") {
      const result = prepareGatewaySuspend({
        requestId: stringParam(request, "requestId"),
        drain: true,
        terminalPolicy: "terminate",
        pauseScheduling: () => f.events.push("scheduler:paused"),
        resumeScheduling: () => f.events.push("scheduler:resumed"),
        inspect: inspectors({
          getRootRequests: () => f.ordinaryWork,
          getTerminalPersistence: () => f.persistence,
        }),
        nowMs: () => f.epoch,
      });
      if (result.status === "ready" || result.status === "draining") {
        f.suspensionId = result.suspensionId;
      }
      f.events.push(`prepared:${result.status}`);
      return result;
    }
    if (request.method === "gateway.suspend.handoff") {
      const input = params(request);
      expect(input.target).toEqual({ pid, processInstanceId: "original-process-instance" });
      const owner = host.capability.externalRestart;
      if (!owner) {
        throw new Error("Fixture host has no process-exit owner");
      }
      const result = armGatewaySuspendHandoff({
        suspensionId: stringParam(request, "suspensionId"),
        owner,
        ...(input.commit === true ? { commit: true } : {}),
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      if (result.value.status === "committed" && f.loseCommittedReply) {
        throw new Error("Synthetic transport lost the committed reply");
      }
      return result.value;
    }
    if (request.method === "gateway.suspend.resume") {
      return resumeGatewaySuspend(stringParam(request, "suspensionId"));
    }
    throw new Error(`Unsupported fixture Gateway method: ${request.method}`);
  });
  mocks.openBroker.mockImplementation(async () => {
    let mutationInspection = false;
    const query: Awaited<ReturnType<typeof openSystemdBroker>>["query"] = async (
      args,
      _signatures,
      _deadline,
      current,
      dispatch,
    ) => {
      current?.();
      const method = args[4];
      if (method === "GetId") {
        return [["a".repeat(32)]];
      }
      if (method === "GetNameOwner") {
        if (mutationInspection) {
          await Promise.resolve();
          f.events.push("native:inspected");
          f.atNativeInspection?.();
          mutationInspection = false;
        }
        return [[":1.42"]];
      }
      if (method === "GetConnectionUnixUser") {
        return [[0]];
      }
      if (method === "GetUnit" || method === "LoadUnit") {
        mutationInspection = method === "LoadUnit";
        return [["/org/freedesktop/systemd1/unit/immutable_2dnative_2dfixture_2eservice"]];
      }
      if (args[0] === "get-property") {
        return method === "Id"
          ? [descriptor.service.unit, sourcePath]
          : [descriptor.service.account];
      }
      if (method === "StopUnit") {
        await Promise.resolve();
        f.beforeDispatch?.();
        current?.();
        dispatch?.();
        f.events.push(
          isGatewayWorkAdmissionClosed() ? "effect:admission-closed" : "effect:admission-open",
        );
        f.events.push("effect:StopUnit");
        f.alive = false;
        current?.();
        return [["/org/freedesktop/systemd1/job/7"]];
      }
      throw new Error(`Unsupported fixture native method: ${method}`);
    };
    return { query, close: async () => {}, verify: () => {} };
  });
});
afterEach(async () => {
  await host?.retire();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

async function stopWithLiveDrain() {
  const observed = await inspectImmutableActivationService({
    descriptor,
    generationPath: descriptor.current.path,
    assertCurrent,
  });
  return withGatewayMaintenanceDrain(
    {
      state: observed.state,
      timeoutMs: 0,
      drainPolicy: "interrupt-after-drain",
      assertCurrent,
      warn: () => {},
    },
    async (guard) => {
      f.events.push("stop:entered");
      await controlImmutableService("stop", {
        descriptor,
        expected: observed,
        assertCurrent,
        stdout: new PassThrough(),
        prepareEffect: guard ? () => guard.prepareEffect(f.assertProtection) : undefined,
        beforeEffect: f.assertProtection,
      });
      f.events.push("stop:settled");
    },
  );
}

const test = it.skipIf(process.platform !== "linux");
test.each(["ready", "draining"] as const)(
  "settles the process behind the live %s lease",
  async (phase) => {
    f.ordinaryWork = Number(phase === "draining");
    await stopWithLiveDrain();
    expect(f.events).toContain(`prepared:${phase}`);
    expect(f.events.filter((event) => event === "effect:StopUnit")).toHaveLength(1);
    expect(f.events).toContain("effect:admission-closed");
    expect(f.events.indexOf("cgroup:empty")).toBeGreaterThan(f.events.indexOf("effect:StopUnit"));
    expect(f.events.at(-1)).toBe("stop:settled");
    expect(f.alive).toBe(false);
  },
);

test.each(["native inspection", "handoff dispatch"] as const)(
  "refuses protected config drift at %s",
  async (window) => {
    const file = path.join(root, "protected-config.json");
    fs.writeFileSync(file, "original bytes");
    f.assertProtection = () => {
      if (fs.readFileSync(file, "utf8") !== "original bytes") {
        throw new Error("protected config changed");
      }
    };
    const replace = () => fs.writeFileSync(file, "foreign bytes");
    if (window === "native inspection") {
      f.atNativeInspection = replace;
    } else {
      f.beforeHandoffDispatch = replace;
    }
    await expect(stopWithLiveDrain()).rejects.toThrow("protected config changed");
    expect(f.events).toContain("native:inspected");
    expect(f.events).not.toContain("host:committed");
    expect(f.events).not.toContain("effect:StopUnit");
    expect(f).toMatchObject({ shutdownCommitted: false, alive: true });
  },
);

test.each(["expiry", "resume", "write custody", "boot replacement"] as const)(
  "preserves the resident after %s during inspection",
  async (change) => {
    f.atNativeInspection = () => {
      if (change === "expiry") {
        f.epoch += 120_000;
        f.monotonic += 120_000;
        expect(getGatewaySuspendStatus(f.suspensionId, true)).toMatchObject({ status: "running" });
      } else if (change === "resume") {
        expect(resumeGatewaySuspend(f.suspensionId)).toMatchObject({ ok: true, resumed: true });
      } else if (change === "write custody") {
        f.persistence = 1;
      } else {
        f.bootId = "replacement-boot";
      }
    };
    const outcome = await stopWithLiveDrain().catch((error: unknown) => error);
    expect(f.events).toContain("native:inspected");
    expect(f.events.filter((event) => event === "effect:StopUnit")).toHaveLength(0);
    expect(outcome).toBeInstanceOf(Error);
    expect(f.alive).toBe(true);
  },
);

test.each(["forward clock jump", "backward clock jump", "resume"] as const)(
  "keeps shutdown committed after %s before dispatch",
  async (change) => {
    let resumed: ReturnType<typeof resumeGatewaySuspend> | undefined;
    f.beforeDispatch = () => {
      if (change === "resume") {
        resumed = resumeGatewaySuspend(f.suspensionId);
      } else {
        f.epoch += change === "forward clock jump" ? 120_000 : -120_000;
        f.monotonic += 120_000;
      }
    };
    await stopWithLiveDrain();
    expect(f.events).toContain("native:inspected");
    expect(f.events.filter((event) => event === "host:committed")).toHaveLength(1);
    expect(f.events.filter((event) => event === "effect:StopUnit")).toHaveLength(1);
    expect(f.events).not.toContain("effect:admission-open");
    expectCommittedAdmission();
    expect(f.alive).toBe(false);
    if (change === "resume") {
      expect(resumed).toEqual({ ok: false, reason: "gateway-restarting" });
    }
  },
);

test("settles exit between host commitment and native dispatch", async () => {
  f.beforeDispatch = () => {
    f.alive = false;
  };
  await stopWithLiveDrain();
  expect(f.events.filter((event) => event === "host:committed")).toHaveLength(1);
  expect(f.events.filter((event) => event === "effect:StopUnit")).toEqual([]);
  expect(f.events.at(-1)).toBe("stop:settled");
});

test("preserves a process replacing the committed host", async () => {
  f.beforeDispatch = () => {
    f.processTicks++;
  };
  const outcome = await stopWithLiveDrain().catch((error: unknown) => error);
  expect(f.events).toContain("host:committed");
  expect(f.events.filter((event) => event === "effect:StopUnit")).toEqual([]);
  expect(outcome).toBeInstanceOf(Error);
  expect(f.alive).toBe(true);
});

test("keeps lost-reply shutdown committed without native stop", async () => {
  f.loseCommittedReply = true;
  await expect(stopWithLiveDrain()).rejects.toThrow("lost the committed reply");
  expect(f.events.filter((event) => event === "host:committed")).toHaveLength(1);
  expect(f.events.filter((event) => event === "effect:StopUnit")).toEqual([]);
  expect(resumeGatewaySuspend(f.suspensionId)).toEqual({ ok: false, reason: "gateway-restarting" });
  expectCommittedAdmission();
});

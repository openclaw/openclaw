import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admitUpdateCommandRun } from "../cli/update-cli/update-command-run.js";
import * as containerEnvironment from "../infra/container-environment.js";
import { getUpdateRun } from "../infra/update-run-ledger.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { captureEnv } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveNodeService } from "./node-service.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import type { GatewayService } from "./service.js";
import { readGatewayServiceState, resolveGatewayService, startGatewayService } from "./service.js";
import {
  createMockGatewayService,
  managerlessPreflightCases,
  mockSystemAccountHome,
} from "./service.test-helpers.js";

const probePortUsage = vi.hoisted(() =>
  vi.fn<typeof import("../infra/ports-probe.js").probePortUsage>(),
);

vi.mock("../infra/ports-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/ports-probe.js")>()),
  probePortUsage,
}));

beforeEach(() => {
  mockSystemAccountHome();
  probePortUsage.mockReset();
  probePortUsage.mockRejectedValue(new Error("unexpected port probe"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const createService = createMockGatewayService;
const startArgs = { env: {}, stdout: process.stdout };
const gatewayCommand = { programArguments: ["openclaw", "gateway", "run"] };
function startableService(overrides: Partial<GatewayService> = {}) {
  return createService({
    readCommand: vi.fn(async () => gatewayCommand),
    isLoaded: vi.fn(async () => true),
    ...overrides,
  });
}

describe("resolveGatewayService", () => {
  it.each([{ name: "node", resolve: resolveNodeService }])(
    "returns a read-only unsupported-platform $name adapter",
    async ({ resolve }) => {
      mockProcessPlatform("aix");
      const service = resolve();

      await expect(service.readCommand(process.env)).resolves.toBeNull();
      await expect(service.isLoaded({ env: process.env })).rejects.toThrow(
        "Gateway service install not supported on aix",
      );
      await expect(service.readRuntime(process.env)).resolves.toEqual({
        status: "unknown",
        detail: "Gateway service install not supported on aix",
      });
      await expect(service.start({ env: process.env, stdout: process.stdout })).rejects.toThrow(
        "Gateway service install not supported on aix",
      );
      await expect(service.restart({ env: process.env, stdout: process.stdout })).rejects.toThrow(
        "Gateway service install not supported on aix",
      );
    },
  );

  it.each(["gateway", "node"] as const)("keeps FreeBSD %s ownership external", async (kind) => {
    mockProcessPlatform("freebsd");
    vi.spyOn(containerEnvironment, "isContainerEnvironment").mockReturnValue(false);
    const service = kind === "gateway" ? resolveGatewayService() : resolveNodeService();
    const runtime = await service.readRuntime(process.env);
    expect(runtime.status).toBe("unknown");
    expect(service.unsupportedReason).toBe(runtime.detail);
    if (kind === "node") {
      expect(runtime.detail).toContain("Node service management is not supported");
      expect(runtime.detail).toContain("`openclaw node run`");
      expect(runtime.detail).not.toContain("service openclaw");
      expect(runtime.detail).not.toContain("openclaw gateway run");
    } else {
      for (const hint of [
        "not supported by this CLI on FreeBSD",
        "openclaw_user to your onboarding account",
        'openclaw_enable="YES" in /etc/rc.conf',
        "`service openclaw start` (or stop/restart/status) as root",
        "`openclaw gateway run` as your onboarding account",
      ]) {
        expect(runtime.detail).toContain(hint);
      }
      const { collectGatewayDaemonFindings } =
        await import("../flows/doctor-core-checks.runtime.js");
      await expect(
        collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } }),
      ).resolves.toEqual([
        expect.objectContaining({
          checkId: "core/doctor/gateway-daemon",
          severity: "warning",
          fixHint: runtime.detail,
        }),
      ]);
    }
    const args = {
      env: process.env,
      stdout: process.stdout,
      programArguments: ["openclaw", kind, "run"],
    };
    for (const action of ["stage", "install", "uninstall", "start", "stop", "restart"] as const) {
      await expect(service[action](args)).rejects.toThrow(runtime.detail);
    }
    await expect(service.isLoaded(args)).rejects.toThrow(runtime.detail);
    await expect(service.readCommand(process.env)).resolves.toBeNull();
    await expect(readGatewayServiceState(service)).resolves.toMatchObject({
      installed: false,
      loadState: { status: "unknown", detail: `Error: ${runtime.detail}` },
      running: false,
      command: null,
      runtime,
    });
  });

  it("guards every native service mutation when an external supervisor owns lifecycle", async () => {
    mockProcessPlatform("darwin");
    const service = resolveGatewayService();
    const env = { OPENCLAW_SUPERVISOR_MODE: "external" };
    const installArgs = {
      env,
      stdout: process.stdout,
      programArguments: ["openclaw", "gateway", "run"],
    };
    for (const action of ["stage", "install", "uninstall", "start", "stop", "restart"] as const) {
      await expect(service[action](installArgs)).rejects.toThrow(
        "gateway lifecycle is managed by an external supervisor",
      );
    }
  });
});

describe("readGatewayServiceState", () => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(0);
  });

  it("uses the registered Windows launcher for loaded-only status", async () => {
    mockProcessPlatform("win32");
    const configured = "C:\\config\\gateway.cmd";
    const registered = "C:\\registered\\gateway.cmd";
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["node", "openclaw", "gateway", "run"],
        sourcePath: registered,
      })),
      isLoaded: vi.fn<GatewayService["isLoaded"]>(
        async (options = {}) => options.env?.OPENCLAW_TASK_SCRIPT === registered,
      ),
      readRuntime: vi.fn<GatewayService["readRuntime"]>(async (env) => ({
        status: env?.OPENCLAW_TASK_SCRIPT === registered ? "running" : "unknown",
      })),
    });

    const state = await readGatewayServiceState(service, {
      env: { OPENCLAW_TASK_SCRIPT: configured },
      requireEffective: true,
      requireLoadedCommand: true,
    });

    expect(state).toMatchObject({
      loadState: { status: "loaded" },
      running: true,
      env: { OPENCLAW_TASK_SCRIPT: registered },
    });
  });

  it.each(
    managerlessPreflightCases.filter(
      ({ condition, updateInstallKind, shouldRestart }) =>
        (condition === "absent" && updateInstallKind === "git" && !shouldRestart) ||
        ["node absent", "node installed", "unreadable", "unknown port"].includes(condition),
    ),
  )(
    "handles managerless Linux inspection for $updateInstallKind restart=$shouldRestart ($condition)",
    async ({ updateInstallKind, shouldRestart, condition, portUsage }) => {
      const { maybeStopManagedServiceBeforeMutableUpdate } =
        await import("../cli/update-cli/update-command-service-maintenance.js");
      const home = await makeTempWorkspace("openclaw-managerless-preflight-");
      const keys = (
        "HOME PATH OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE " +
        "OPENCLAW_GATEWAY_PORT OPENCLAW_SUPERVISOR_MODE OPENCLAW_SERVICE_MARKER " +
        "OPENCLAW_SERVICE_KIND OPENCLAW_SYSTEMD_UNIT DBUS_SESSION_BUS_ADDRESS " +
        "DBUS_SYSTEM_BUS_ADDRESS XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_CONFIG_DIRS " +
        "XDG_DATA_HOME XDG_DATA_DIRS SYSTEMD_UNIT_PATH SUDO_USER"
      ).split(" ");
      const snapshot = captureEnv(keys);
      try {
        mockProcessPlatform("linux");
        for (const key of keys) {
          delete process.env[key];
        }
        process.env.HOME = home;
        process.env.PATH = home;
        process.env.XDG_RUNTIME_DIR = path.join(home, "runtime");
        const expectedPort = 19901;
        process.env.OPENCLAW_GATEWAY_PORT = String(expectedPort);
        if (portUsage) {
          probePortUsage.mockResolvedValue(portUsage);
        }
        const node = condition.startsWith("node ");
        const unit = path.join(
          home,
          `.config/systemd/user/openclaw-${node ? "node" : "gateway"}.service`,
        );
        if (condition === "node installed") {
          await fs.mkdir(path.dirname(unit), { recursive: true });
          await fs.writeFile(unit, "[Service]\nExecStart=/missing/openclaw node run\n");
        }
        const native = await import("./systemd-peer-native.js");
        for (const method of ["openSystemdBroker", "openSystemdPrivatePeer"] as const) {
          vi.spyOn(native, method).mockRejectedValue(
            new Error("Synthetic native manager unavailable"),
          );
        }
        vi.spyOn(await import("./exec-file.js"), "execFileUtf8").mockResolvedValue({
          stdout: "",
          stderr: "service manager unavailable",
          code: 1,
          termination: "error",
          errorCode: "ENOENT",
        });
        if (node) {
          // Only the fixture HOME contains definitions; no native manager is contacted.
          const access = fs.access;
          vi.spyOn(fs, "access").mockImplementation(async (target, mode) => {
            if (!String(target).startsWith(`${home}${path.sep}`)) {
              throw Object.assign(new Error("missing"), { code: "ENOENT" });
            }
            return access(target, mode);
          });
          vi.spyOn(fs, "readdir").mockResolvedValue([]);
        }
        const lstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
          const name = String(target);
          if (node && !name.startsWith(`${home}${path.sep}`)) {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          if (condition === "unreadable" && name === unit) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          // The host may run systemd; this fixture models a separate managerless namespace.
          if (name === "/run/systemd" || /^\/run\/user\/\d+\/systemd$/.test(name)) {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          return lstat(target, options);
        });
        if (node) {
          const result = await readGatewayServiceState(resolveNodeService(), {
            env: process.env,
            timeoutMs: 2_000,
          });
          expect(result.installed).toBe(condition === "node installed");
          if (condition === "node installed") {
            expect(result.command?.sourcePath).toBe(unit);
            expect(result.loadState.status).toBe("unknown");
            expect(result.runtime?.status).toBe("unknown");
          } else {
            expect(result.command).toBeNull();
            expect(result.runtime?.missingUnit).toBe(true);
          }
          return;
        }
        if (condition === "absent") {
          const run = await admitUpdateCommandRun({ opts: { restart: shouldRestart }, root: home });
          expect(run.env.HOME).toBe(home);
          expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
        }
        const result = await maybeStopManagedServiceBeforeMutableUpdate({
          root: home,
          updateInstallKind,
          shouldRestart,
          jsonMode: true,
          phase: "inspect",
          timeoutMs: 2_000,
        });
        expect(result.blockMessage).toBeUndefined();
        if (condition === "absent") {
          expect(result.serviceMutationSkipMessage).toContain("no Gateway service or listener");
          expect(result.serviceUpdateVerdict?.kind).toBe("absent");
        } else {
          expect(result.serviceUpdateVerdict).toMatchObject({
            kind: "unavailable",
            inspectionReason: "service-manager-unavailable",
          });
          expect(result.serviceMutationSkipMessage).toContain(
            "No supported service manager detected",
          );
          expect(result.serviceMutationSkipMessage).toContain("Stop the Gateway through its owner");
          expect(result.serviceEnv).toBeUndefined();
          expect(result.serviceDefinitionEnv).toBeUndefined();
          expect(result.serviceNodeRunner).toBeUndefined();
        }
        expect(result.serviceMutationAllowed).toBe(false);
        expect(result.stopped).toBe(false);
        if (portUsage) {
          expect(probePortUsage).toHaveBeenCalledOnce();
          expect(probePortUsage).toHaveBeenCalledWith(expectedPort);
        } else {
          expect(probePortUsage).not.toHaveBeenCalled();
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
        snapshot.restore();
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

  it("retains service state when strict capability inspection fails", async () => {
    const hasInstalledDefinition = vi.fn(async () => false);
    const readDefinitionMutationCapability = vi.fn<
      NonNullable<GatewayService["readDefinitionMutationCapability"]>
    >(async () => {
      throw new Error("capability unavailable");
    });
    const service = createService({
      hasInstalledDefinition,
      readDefinitionMutationCapability,
      isLoaded: vi.fn(async () => true),
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      })),
      readRuntime: vi.fn(async () => ({ status: "running" })),
    });

    const state = await readGatewayServiceState(service, {
      env: { OPENCLAW_GATEWAY_PORT: "1" },
      requireEffective: true,
      timeoutMs: 100,
    });

    expect(state.installed).toBe(true);
    expect(state.loadState).toEqual({ status: "loaded" });
    expect(state.running).toBe(true);
    expect(state.env.OPENCLAW_GATEWAY_PORT).toBe("18789");
    expect(hasInstalledDefinition).not.toHaveBeenCalled();
    expect(state.definitionMutationCapability).toEqual({
      kind: "unknown",
      reason: "inspection-failed",
    });
  });

  it("does not infer installed ownership from failed definition inspection", async () => {
    const hasInstalledDefinition = vi.fn(async () => {
      throw new Error("service definition inspection failed");
    });
    const service = createService({ hasInstalledDefinition });
    const env = { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" };

    const state = await readGatewayServiceState(service, { env, timeoutMs: 100 });

    expect(state.installed).toBe(false);
    expect(state.command).toBeNull();
    expect(state.env).toBe(env);
  });

  it("bounds structured runtime inspection diagnostics", async () => {
    const service = createService({
      readRuntime: vi.fn(async () => {
        throw new Error("錯".repeat(600));
      }),
    });

    const state = await readGatewayServiceState(service);

    expect(state.runtime?.inspectionFailure).toMatchObject({
      code: "service-runtime-inspection-failed",
    });
    expect(state.runtime?.inspectionFailure?.detail).toHaveLength(500);
  });

  it("validates merged service env before native status probes", async () => {
    const isLoaded = vi.fn(async () => true);
    const readRuntime = vi.fn(async () => ({ status: "running" as const }));
    const readDefinitionMutationCapability =
      vi.fn<NonNullable<GatewayService["readDefinitionMutationCapability"]>>();
    const service = createService({
      isLoaded,
      readDefinitionMutationCapability,
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
        environment: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      })),
      readRuntime,
    });

    await expect(
      readGatewayServiceState(service, {
        env: {},
        requireEffective: true,
        validateEnvBeforeStatusRead: (env) => {
          throw new Error(`refused ${env.OPENCLAW_SYSTEMD_UNIT}`);
        },
      }),
    ).rejects.toThrow("refused openclaw-gateway.service");

    expect(isLoaded).not.toHaveBeenCalled();
    expect(readRuntime).not.toHaveBeenCalled();
    expect(readDefinitionMutationCapability).not.toHaveBeenCalled();
  });
});

describe("startGatewayService", () => {
  it("rejects an unknown post-start service inspection", async () => {
    const service = startableService({
      isLoaded: vi
        .fn<GatewayService["isLoaded"]>()
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error("post-start inspection failed")),
      readRuntime: vi
        .fn<GatewayService["readRuntime"]>()
        .mockResolvedValueOnce({ status: "stopped" })
        .mockResolvedValueOnce({ status: "running" }),
    });

    await expect(startGatewayService(service, startArgs)).rejects.toThrow(
      "Service status inspection failed after start: Error: post-start inspection failed",
    );
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    { runtime: { status: "stopped", lastExitStatus: 78 }, failure: "exit 78" },
    { runtime: { status: "stopped", state: "failed" }, failure: "state failed" },
  ] as const)(
    "reports explicit post-start $failure instead of success",
    async ({ runtime, failure }) => {
      const service = startableService({
        readRuntime: vi
          .fn<GatewayService["readRuntime"]>()
          .mockResolvedValueOnce({ status: "stopped" })
          .mockResolvedValueOnce(runtime),
      });

      await expect(startGatewayService(service, startArgs)).rejects.toThrow(
        `Service failed to start (${failure})`,
      );
      expect(service.start).toHaveBeenCalledTimes(1);
    },
  );

  it("does not mistake a previous exit code for a new asynchronous start failure", async () => {
    const service = startableService({
      readRuntime: vi.fn(async () => ({ status: "stopped", lastExitStatus: 78 })),
    });

    await expect(startGatewayService(service, startArgs)).resolves.toMatchObject({
      outcome: "started",
    });
  });

  it("ignores legacy version metadata on an already-running service", async () => {
    const service = startableService({
      readCommand: vi.fn(async () => ({
        ...gatewayCommand,
        environment: { OPENCLAW_SERVICE_VERSION: "2026.4.24" },
      })),
      readRuntime: vi.fn(async () => ({ status: "running", pid: 4242 })),
    });

    const result = await startGatewayService(service, startArgs);
    expect(result).toMatchObject({
      outcome: "already-running",
      issues: [],
      state: { runtime: { pid: 4242 } },
    });
    expect(service.start).not.toHaveBeenCalled();
  });

  it("requests repair before start when the managed port differs from config", async () => {
    const service = startableService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "--port", "18789"],
        environment: { OPENCLAW_GATEWAY_PORT: "19001" },
      })),
      readRuntime: vi.fn(async () => ({ status: "stopped" })),
    });

    const result = await startGatewayService(service, startArgs, 19_001);
    expect(result.outcome).toBe("repair-required");
    if (result.outcome === "repair-required") {
      expect(result.issues).toContainEqual({
        message: "service port 18789 does not match current gateway config port 19001",
      });
    }
    expect(service.start).not.toHaveBeenCalled();
  });

  describe("service program paths", () => {
    const entrypoint = path.resolve("openclaw.mjs");
    const missing = path.resolve("missing-gateway-entrypoint.cjs");
    const temporary = path.join(os.tmpdir(), "openclaw-service-layout", "index.js");
    const heapFlag = "--max-old-space-size=16384";

    it.each([
      { kind: "missing", program: missing },
      { kind: "temporary", program: temporary },
    ])(
      "requests repair for $kind node-host entrypoint after dev loader",
      async ({ kind, program }) => {
        const service = startableService({
          readCommand: vi.fn(async () => ({
            programArguments: ["node", "--import", "tsx", program, "node", "run"],
          })),
        });

        const result = await startGatewayService(service, startArgs);

        expect.soft(result).toMatchObject({
          outcome: "repair-required",
          issues: [
            {
              message: `service command points at a ${kind} path: ${program}`,
            },
          ],
        });
        expect(service.start).not.toHaveBeenCalled();
      },
    );

    it("starts a relative entrypoint without inspecting application paths", async () => {
      const service = startableService({
        readCommand: vi.fn(async () => ({
          programArguments: [
            "node",
            heapFlag,
            path.basename(entrypoint),
            "gateway",
            "--config",
            missing,
            "--log-file",
            temporary,
            "gateway",
          ],
          workingDirectory: path.dirname(entrypoint),
        })),
      });

      const result = await startGatewayService(service, startArgs);

      expect(result.outcome).toBe("started");
      expect(service.start).toHaveBeenCalledOnce();
    });
  });

  it.each(["ordinary", "cleanup", "ownership"] as const)(
    "keeps %s start failure distinct if artifacts disappear",
    async (kind) => {
      const failure =
        kind === "cleanup"
          ? new CommandProcessCleanupError()
          : kind === "ownership"
            ? new ServiceOwnershipRefusalError("systemd-manager-changed")
            : new Error("launchctl bootstrap failed");
      const readCommand = vi
        .fn<GatewayService["readCommand"]>()
        .mockResolvedValueOnce({
          programArguments: ["openclaw", "gateway", "run"],
        })
        .mockResolvedValueOnce(null);
      const service = createService({
        readCommand,
        start: vi.fn(async () => {
          throw failure;
        }),
      });

      const operation = startGatewayService(service, {
        env: {},
        stdout: process.stdout,
      });
      if (kind === "ordinary") {
        await expect(operation).resolves.toMatchObject({
          outcome: "missing-install",
          state: { installed: false },
        });
      } else {
        await expect(operation).rejects.toBe(failure);
      }
    },
  );
});

// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import * as legacyGatewayLock from "../infra/gateway-lock-legacy.js";
import * as packageJson from "../infra/package-json.js";
import * as builtRuntime from "../infra/update-git-runtime.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");
const candidateVersion = "2026.9.4";
const candidateBuildId = "2026.9.4-synthetic-candidate";

function managedService(
  state: OpenClawTestState,
  initiallyRunning: boolean,
  events: string[] = [],
) {
  let running = initiallyRunning;
  let pid = 4200;
  mocks.resident.mockImplementation(() => (running ? { pid } : undefined));
  const stop = vi.fn(async () => {
    events.push("stop");
    running = false;
  });
  const restart = vi.fn(async () => {
    events.push("restart");
    pid += 1;
    running = true;
    return { outcome: "completed" as const };
  });
  const service = {
    readCommand: async () => ({
      programArguments: [
        process.execPath,
        path.join(process.cwd(), "openclaw.mjs"),
        "gateway",
        "--port",
        "19754",
      ],
      environment: {
        OPENCLAW_STATE_DIR: state.stateDir,
        OPENCLAW_CONFIG_PATH: state.configPath,
      },
    }),
    readRuntime: async (): Promise<GatewayServiceRuntime> => ({
      status: running ? "running" : "stopped",
      ...(running ? { pid } : {}),
      systemd: { managerUid: process.getuid?.() ?? 2001 },
    }),
    readLoadState: async () => ({ status: running ? "loaded" : "not-loaded" }),
    isLoaded: async () => running,
    isEnabled: async () => running,
    stop,
    restart,
  };
  mocks.service.mockReturnValue(service);
  return service;
}

function inspectStaleBuild() {
  mocks.inspectGatewayRestart.mockImplementation(async (params) => {
    const runtime = await params.service.readRuntime(params.env ?? process.env);
    const stale = runtime.pid === 4200;
    return {
      runtime,
      portUsage: { port: params.port, status: "busy", listeners: [], hints: [] },
      healthy: !stale,
      staleGatewayPids: [],
      gatewayVersion: candidateVersion,
      gatewayBuildId: stale ? "2026.9.4-synthetic-previous" : candidateBuildId,
      gatewayBootId: stale ? "previous-boot" : "candidate-boot",
      ...(stale
        ? {
            buildIdMismatch: {
              expected: candidateBuildId,
              actual: "2026.9.4-synthetic-previous",
            },
          }
        : {}),
    };
  });
}

describe("Doctor invoked by the published 2026.6.33 updater", () => {
  beforeEach(() => {
    // These are the shipped parent's markers, not the current updater's builder.
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "1");
    vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", "1");
    vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", undefined);
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", undefined);
    mocks.config.mockReset().mockReturnValue({});
    mocks.packageRoot.mockReturnValue(process.cwd());
    mocks.service.mockReset();
    mocks.probePortUsage.mockReset().mockResolvedValue("free");
    mocks.restartedHealthy = true;
    mocks.emulateNativeInstall = true;
    mocks.servicePlatform = undefined;
    mocks.taskDefinitelyStopped.mockReset().mockReturnValue(true);
    mocks.startupFallbackRuntime.mockReset().mockResolvedValue(null);
    mocks.outro.mockClear();
    mocks.runContributions.mockReset().mockResolvedValue(undefined);
    mocks.writeUpdatePostInstallDoctorResult.mockClear();
    vi.spyOn(packageJson, "readPackageVersion").mockResolvedValue(candidateVersion);
    vi.spyOn(builtRuntime, "readBuiltGatewayBuildId").mockResolvedValue(candidateBuildId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("admits maintenance when the same legacy update's Gateway is already stopped", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({});
      const service = managedService(state, false);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });

      expect(mocks.runContributions).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ gatewayMaintenanceActive: true }),
      );
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(await service.readRuntime()).toMatchObject({ status: "stopped" });
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    });
  });

  it.each(["mismatched build", "missing RPC chunks"])(
    "replaces %s and verifies it after offline maintenance",
    async (failure) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({});
        const events: string[] = [];
        const service = managedService(state, true, events);
        mocks.probePortUsage.mockImplementation(async () => {
          expect(await service.readRuntime()).toMatchObject({ status: "stopped" });
          events.push("verified-stop");
          return "free";
        });
        inspectStaleBuild();
        if (failure === "missing RPC chunks") {
          mocks.inspectGatewayRestart.mockImplementation(async (params) => ({
            runtime: await service.readRuntime(),
            portUsage: { port: params.port, status: "busy", listeners: [], hints: [] },
            healthy: false,
            staleGatewayPids: [],
            gatewayVersion: null,
            probeError:
              "gateway closed (1011): gateway message handler unavailable\\nGateway target: ws://127.0.0.1:18789",
          }));
        }
        mocks.waitForGatewayHealthyRestart.mockImplementation(async (params) => {
          expect(params.port).toBe(19754);
          events.push("verified");
          return {
            runtime: await service.readRuntime(),
            portUsage: { port: params.port, status: "busy", listeners: [], hints: [] },
            healthy: true,
            staleGatewayPids: [],
            gatewayVersion: candidateVersion,
            gatewayBuildId: candidateBuildId,
            gatewayBootId: "candidate-boot",
            waitOutcome: "healthy",
          };
        });
        mocks.runContributions.mockImplementation(async (ctx) => {
          events.push("repair");
          expect(ctx.gatewayMaintenanceActive).toBe(true);
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });

        expect(events).toEqual(["stop", "verified-stop", "repair", "restart", "verified"]);
        expect(service.restart).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ preserveDefinition: true }),
        );
        expect(mocks.waitForGatewayHealthyRestart).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            expectedVersion: candidateVersion,
            expectedBuildId: candidateBuildId,
            requireRunningService: true,
            env: expect.objectContaining({ OPENCLAW_UPDATE_IN_PROGRESS: "1" }),
          }),
        );
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
      });
    },
  );

  it("imports retained legacy sessions after verified stop and before any candidate RPC", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const sessionKey = "agent:main:legacy";
      const sessionId = "retained-legacy-session";
      const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
      await state.writeConfig(cfg);
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: { sessionId, updatedAt: 1 } }));
      mocks.config.mockReturnValue(cfg);
      const events: string[] = [];
      const service = managedService(state, true, events);
      vi.spyOn(legacyGatewayLock, "readLegacyGatewayLockIdentity").mockImplementation(async () => {
        const runtime = await service.readRuntime();
        return runtime.pid === 4200
          ? { pid: 4200, state: "alive", path: state.path("legacy-gateway.lock") }
          : undefined;
      });
      mocks.inspectGatewayRestart.mockImplementation(async () => {
        throw new Error("RPC attempted before retained session import");
      });
      mocks.probePortUsage.mockImplementation(async () => {
        expect(await service.readRuntime()).toMatchObject({ status: "stopped" });
        events.push("verified-stop");
        return "free";
      });
      mocks.runContributions.mockImplementation(async (ctx) => {
        expect(ctx.gatewayMaintenanceActive).toBe(true);
        expect(events).toEqual(["stop", "verified-stop"]);
        expect(service.restart).not.toHaveBeenCalled();
        const imported = await runDoctorSessionSqlite({
          cfg: ctx.cfg,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
        expect(imported.totals.importedEntries).toBe(1);
        expect(imported.totals.archivedLegacyStoreFiles).toBe(1);
        events.push("import");
      });
      mocks.waitForGatewayHealthyRestart.mockImplementation(async (params) => {
        expect(events).toEqual(["stop", "verified-stop", "import", "restart"]);
        expect(
          loadExactSessionEntry({
            env: state.env,
            agentId: "main",
            storePath,
            sessionKey,
          })?.entry.sessionId,
        ).toBe(sessionId);
        expect(params).toMatchObject({
          expectedVersion: candidateVersion,
          expectedBuildId: candidateBuildId,
        });
        events.push("verified");
        return {
          runtime: await service.readRuntime(),
          portUsage: { port: params.port, status: "busy", listeners: [], hints: [] },
          healthy: true,
          staleGatewayPids: [],
          gatewayVersion: candidateVersion,
          gatewayBuildId: candidateBuildId,
          gatewayBootId: "candidate-boot",
          waitOutcome: "healthy",
        };
      });

      await runDoctorHealthFlow(
        { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        { repair: true, nonInteractive: true },
      );

      expect(events).toEqual(["stop", "verified-stop", "import", "restart", "verified"]);
      expect(mocks.inspectGatewayRestart).not.toHaveBeenCalled();
      expect(mocks.waitForGatewayHealthyRestart).toHaveBeenCalledOnce();
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    });
  });

  it("repairs unavailable identity without treating it as a stale build", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({});
      const events: string[] = [];
      const service = managedService(state, true, events);
      mocks.inspectGatewayRestart.mockImplementation(async (params) => ({
        runtime: await service.readRuntime(),
        portUsage: { port: params.port, status: "busy", listeners: [], hints: [] },
        healthy: false,
        staleGatewayPids: [],
        gatewayBuildId: null,
        buildIdMismatch: { expected: candidateBuildId, actual: null },
        probeError: "Gateway TLS certificate unavailable",
      }));
      mocks.runContributions.mockImplementation(async () => {
        events.push("repair");
      });

      await runDoctorHealthFlow(
        { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        { repair: true, nonInteractive: true },
      );

      expect(events).toEqual(["stop", "repair", "restart"]);
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    });
  });

  it.each(["manager-refused", "old-listener-remains"] as const)(
    "reports stale stop failure before repair mutations: %s",
    async (failure) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({});
        const configBefore = fs.readFileSync(state.configPath);
        const resultPath = state.path("doctor-result.json");
        vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
        const service = managedService(state, true);
        inspectStaleBuild();
        if (failure === "manager-refused") {
          service.stop.mockRejectedValueOnce(new Error("synthetic native stop refused"));
        } else {
          mocks.probePortUsage.mockResolvedValue("busy");
        }
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const run = runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });

        await expect(run).rejects.toMatchObject({
          name: "DoctorMaintenanceRefusalError",
          refusal: { kind: "data-at-risk", reason: "gateway-state-unverified" },
          failureFacts: expect.arrayContaining([
            expect.objectContaining({ check: "gateway-stop", code: "stale-gateway-stop-failed" }),
          ]),
        });
        await expect(run).rejects.toThrow(formatCliCommand("openclaw gateway restart", state.env));
        await expect(run).rejects.toThrow(
          formatCliCommand("openclaw gateway status --deep", state.env),
        );
        expect(service.stop).toHaveBeenCalledOnce();
        expect(mocks.config).not.toHaveBeenCalled();
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
        expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
          resultPath,
          result: expect.objectContaining({
            status: "error",
            configHash: "unchanged",
            maintenanceRefusal: { kind: "data-at-risk", reason: "gateway-state-unverified" },
            failureFacts: expect.arrayContaining([
              expect.objectContaining({ check: "gateway-stop", code: "stale-gateway-stop-failed" }),
            ]),
          }),
        });
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
      });
    },
  );

  it("records restoration verification failure after offline repair without publishing success", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({});
      const resultPath = state.path("doctor-result.json");
      vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
      const events: string[] = [];
      const service = managedService(state, true, events);
      inspectStaleBuild();
      mocks.runContributions.mockImplementation(async () => {
        events.push("repair");
      });
      mocks.waitForGatewayHealthyRestart.mockImplementation(async (params) => {
        expect(events).toEqual(["stop", "repair", "restart"]);
        return {
          runtime: await service.readRuntime(),
          portUsage: { port: params.port, status: "busy", listeners: [], hints: [] },
          healthy: false,
          staleGatewayPids: [],
          gatewayVersion: candidateVersion,
          gatewayBuildId: null,
          probeError: "synthetic replacement identity unavailable",
          waitOutcome: "timeout",
        };
      });
      const run = runDoctorHealthFlow(
        { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        { repair: true, nonInteractive: true },
      );
      await expect(run).rejects.toMatchObject({
        name: "UpdateDoctorError",
        failureFacts: expect.arrayContaining([
          expect.objectContaining({
            check: "gateway-restoration",
            code: "doctor-gateway-rpc-verification-failed",
          }),
          expect.objectContaining({ code: "stale-gateway-recovery-command" }),
        ]),
      });
      expect(service.restart).toHaveBeenCalledOnce();
      expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
        resultPath,
        result: expect.objectContaining({
          status: "error",
          failureFacts: expect.arrayContaining([
            expect.objectContaining({
              check: "gateway-restoration",
              code: "doctor-gateway-rpc-verification-failed",
            }),
          ]),
        }),
      });
      expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
    });
  });

  it.each([false, true])(
    "refuses repair behind a live legacy tempfile lock (external=%s)",
    async (external) => {
      if (external) {
        vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", "external");
      }
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({});
        const configBefore = fs.readFileSync(state.configPath);
        const resultPath = state.path("doctor-result.json");
        vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
        const legacyTmpDir = state.path("legacy-tmp");
        const uid = process.getuid?.();
        const lockDir = path.join(legacyTmpDir, uid === undefined ? "openclaw" : `openclaw-${uid}`);
        fs.mkdirSync(lockDir, { recursive: true });
        const configHash = createHash("sha256").update(state.configPath).digest("hex").slice(0, 8);
        const lockPath = path.join(lockDir, `gateway.${configHash}.lock`);
        const startTime = getFileLockProcessStartTime(process.pid);
        expect(startTime).not.toBeNull();
        // 6.33's lock has no port or role; Linux uses the real /proc starttime.
        const lockBefore = JSON.stringify({
          pid: process.pid,
          startTime,
          createdAt: new Date().toISOString(),
          configPath: state.configPath,
        });
        fs.writeFileSync(lockPath, lockBefore);
        const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(legacyTmpDir);
        const service = managedService(state, true);
        service.readCommand = async () => {
          throw new Error("synthetic native manager unavailable");
        };
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        try {
          const run = runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
          await expect(run).rejects.toMatchObject({
            name: "DoctorMaintenanceRefusalError",
            refusal: { kind: "data-at-risk", reason: "gateway-state-unverified" },
            failureFacts: external
              ? []
              : expect.arrayContaining([
                  expect.objectContaining({ code: "stale-gateway-service-unverified" }),
                ]),
          });
          await expect(run).rejects.toThrow(
            formatCliCommand(
              external ? "openclaw doctor --fix" : "openclaw gateway status --deep",
              state.env,
            ),
          );

          expect(service.stop).not.toHaveBeenCalled();
          expect(service.restart).not.toHaveBeenCalled();
          expect(mocks.config).not.toHaveBeenCalled();
          expect(mocks.runContributions).not.toHaveBeenCalled();
          expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
          expect(fs.readFileSync(lockPath, "utf8")).toBe(lockBefore);
          expect(fs.existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
          expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
            resultPath,
            result: expect.objectContaining({
              status: "error",
              configHash: "unchanged",
              maintenanceRefusal: { kind: "data-at-risk", reason: "gateway-state-unverified" },
              failureFacts: external
                ? [
                    expect.objectContaining({
                      check: "doctor",
                      code: "doctor-failed",
                      message: expect.stringContaining("Legacy Gateway lock"),
                    }),
                  ]
                : expect.arrayContaining([
                    expect.objectContaining({ code: "stale-gateway-service-unverified" }),
                  ]),
            }),
          });
          expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        } finally {
          tmpdir.mockRestore();
        }
      });
    },
  );
});

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as nativeLaunchAgentRecovery from "../daemon-cli/launchd-recovery.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
import * as launchAgentRecovery from "./update-command-launch-agent-recovery.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import { applyPostPluginConfigValidation } from "./update-command-post-plugin-validation.js";
import {
  resolveServiceRefreshEnv,
  resolveUpdateTargetEnv,
  resolveOwnedManagedUpdateEnv,
  resolveUpdatedInstallCommandEnv,
} from "./update-command-service-env.js";
import { recoverLaunchAgentAndRecheckGatewayHealth } from "./update-command-service-recovery.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

const tempDirs = createTempDirTracker();
const stoppedHealth = () => ({
  runtime: { status: "stopped" as const },
  portUsage: { port: 18790, status: "free" as const, listeners: [], hints: [] },
  healthy: false,
  staleGatewayPids: [],
  waitOutcome: "stopped-free" as const,
});
const recoveryMessage =
  "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.";
const serviceState = (env = {}, loaded = false) => ({
  installed: true,
  loadState: { status: loaded ? ("loaded" as const) : ("not-loaded" as const) },
  running: false,
  env,
  command: null,
  runtime: { status: "stopped" as const },
});
function expectGuidance(output: string, parts: string[]) {
  for (const part of parts) {
    expect(output).toContain(part);
  }
}
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

it("fails closed when updated plugin migrations leave config invalid", () => {
  const pluginUpdate = createPostCorePluginUpdateResult({ status: "ok", changed: true });
  expect(
    applyPostPluginConfigValidation(pluginUpdate, { status: "invalid", failureFacts: [] }),
  ).toMatchObject({
    status: "error",
    reason: "post-plugin-doctor-invalid-config",
    warnings: [
      {
        guidance: ["Run `openclaw doctor --fix`, then rerun `openclaw update repair`."],
      },
    ],
  });
});

it("uses the managed service port ahead of the caller environment", async () => {
  expect(
    await resolveUpdatedGatewayRestartPort({
      config: { gateway: { port: 19000 } } as never,
      processEnv: { OPENCLAW_GATEWAY_PORT: "19001" },
      serviceEnv: { OPENCLAW_GATEWAY_PORT: "19002" },
    }),
  ).toBe(19002);
});

it("preserves Windows selector lookup semantics without retaining the live environment", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const caller = {
      Home: "/caller/home",
      OpenClaw_State_Dir: "/caller/state",
      OpenClaw_Config_Path: "/caller/config.json",
      OpenClaw_Profile: "caller",
    };
    const snapshot = resolveServiceRefreshEnv(caller);
    caller.OpenClaw_State_Dir = "/later/state";
    expect(snapshot).toEqual({
      HOME: "/caller/home",
      OPENCLAW_STATE_DIR: "/caller/state",
      OPENCLAW_CONFIG_PATH: "/caller/config.json",
      OPENCLAW_PROFILE: "caller",
    });
    const owned = resolveOwnedManagedUpdateEnv({
      processEnv: snapshot,
      serviceEnv: { OpenClaw_State_Dir: "/service/state" },
    });
    expect(owned.OPENCLAW_STATE_DIR).toBe("/service/state");
    expect(owned.OPENCLAW_CONFIG_PATH).toBeUndefined();
    expect(owned.OPENCLAW_PROFILE).toBeUndefined();
    expect(
      resolveUpdateTargetEnv({ baseEnv: caller, serviceEnv: { OPENCLAW_PROFILE: "work" } }),
    ).toMatchObject({ HOME: "/caller/home", OPENCLAW_PROFILE: "work" });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

it("keeps the caller env when no managed service env is available", () => {
  const env = resolveUpdateTargetEnv({
    baseEnv: {
      PATH: "/bin",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_STATE_DIR: "/caller/state",
      OPENCLAW_PROFILE: "caller",
    },
  });

  expect(env).toMatchObject({
    PATH: "/bin",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_STATE_DIR: "/caller/state",
    OPENCLAW_PROFILE: "caller",
  });
});

it("keeps operator scratch and SecretRef inputs while applying managed service selectors", () => {
  const env = resolveUpdatedInstallCommandEnv({
    invocationCwd: "/srv/openclaw",
    processEnv: {
      OPENCLAW_GATEWAY_AUTH_TOKEN: "runtime-token",
      OPENCLAW_STATE_DIR: "/wrong/state",
      OPENCLAW_HOME: "/wrong/home",
      OPENCLAW_PROFILE: "caller",
      PATH: "/caller/bin",
      TMPDIR: "/caller/cache",
      TMP: "/caller/tmp",
      TEMP: "/caller/temp",
    },
    serviceEnv: {
      OPENCLAW_STATE_DIR: "daemon-state",
      OPENCLAW_HOME: "/daemon/home",
      OPENCLAW_PROFILE: "work",
      PATH: "/daemon/bin",
      TMPDIR: "/tmp",
      TMP: "/service/tmp",
      TEMP: "/service/temp",
    },
  });

  expect(env).toMatchObject({
    OPENCLAW_GATEWAY_AUTH_TOKEN: "runtime-token",
    OPENCLAW_STATE_DIR: path.join("/srv/openclaw", "daemon-state"),
    PATH: "/daemon/bin",
    OPENCLAW_HOME: "/daemon/home",
    OPENCLAW_PROFILE: "work",
    TMPDIR: "/caller/cache",
    TMP: "/caller/tmp",
    TEMP: "/caller/temp",
    NODE_DISABLE_COMPILE_CACHE: "1",
  });
  expect(resolveUpdatedInstallCommandEnv({ processEnv: env })).toEqual(env);
});

describe("recoverInstalledLaunchAgentAfterUpdate", () => {
  beforeEach(() => mockProcessPlatform("darwin"));
  afterEach(() => vi.restoreAllMocks());
  it.each(["loaded", "recovered", "failed", "system owner"] as const)(
    "reports LaunchAgent recovery: %s",
    async (outcome) => {
      const service = createMockGatewayService();
      const serviceEnv = { OPENCLAW_PROFILE: "stomme" };
      const recoveredEnv = { ...serviceEnv, OPENCLAW_PORT: "18790" };
      const readState = vi
        .spyOn(gatewayService, "readGatewayServiceState")
        .mockResolvedValue(serviceState(recoveredEnv, outcome === "loaded"));
      const guidance = "System LaunchDaemon system/ai.openclaw.stomme owns this label";
      const recover = vi
        .spyOn(nativeLaunchAgentRecovery, "recoverInstalledLaunchAgent")
        .mockImplementation(async ({ result }) => {
          if (outcome === "system owner") {
            throw new Error(guidance);
          }
          return outcome === "recovered"
            ? { result, loaded: true, message: recoveryMessage }
            : null;
        });

      await expect(
        launchAgentRecovery.recoverInstalledLaunchAgentAfterUpdate({
          service,
          env: serviceEnv,
        }),
      ).resolves.toEqual(
        outcome === "loaded"
          ? { status: "not-needed" }
          : outcome === "recovered"
            ? { status: "recovered", message: recoveryMessage }
            : {
                status: "failed",
                detail:
                  outcome === "system owner"
                    ? guidance
                    : "LaunchAgent was installed but not loaded; automatic bootstrap/kickstart recovery failed.",
              },
      );
      expect(readState).toHaveBeenCalledWith(service, { env: serviceEnv });
      if (outcome === "loaded") {
        expect(recover).not.toHaveBeenCalled();
      } else {
        expect(recover).toHaveBeenCalledWith({ result: "restarted", env: recoveredEnv });
      }
    },
  );
});

describe("recoverLaunchAgentAndRecheckGatewayHealth", () => {
  beforeEach(() => {
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      tempDirs.make("update-native-repair-locks-"),
    );
  });
  afterEach(() => vi.restoreAllMocks());
  it.each(["rejected", "unknown"] as const)(
    "reports and records an uninspectable LaunchAgent without repairing it (%s)",
    async (probe) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("update-probe-failure-") };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      mockProcessPlatform("darwin");
      const service = createMockGatewayService();
      const readState = vi.spyOn(gatewayService, "readGatewayServiceState");
      const reason = "launchctl denied";
      if (probe === "rejected") {
        readState.mockRejectedValue(new Error(reason));
      } else {
        readState.mockResolvedValue({
          ...serviceState(env),
          loadState: { status: "unknown", detail: reason },
        });
      }
      const recover = vi
        .spyOn(nativeLaunchAgentRecovery, "recoverInstalledLaunchAgent")
        .mockResolvedValue(null);
      const start = vi.fn();
      const output = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const result: UpdateRunResult = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
      const verification = await verifyUpdatedGateway({
        result,
        opts: { json: true, run },
        serviceEnv: env,
        gatewayPort: 18790,
        health: stoppedHealth(),
        recoverHealth: (health, _reinspect, assertCurrent) =>
          recoverLaunchAgentAndRecheckGatewayHealth({
            updateRun: run,
            health,
            service,
            port: 18790,
            env,
            assertCurrent,
            onGatewayStartAttempted: start,
          }),
      });
      expect(verification.ok).toBe(false);
      expect(getUpdateRun(run.runId, { env })?.repair).toEqual([
        expect.objectContaining({
          status: "failed",
          summary: expect.stringContaining(`LaunchAgent state could not be inspected: ${reason}`),
        }),
      ]);
      expectGuidance(output.mock.calls.flat().join("\n"), [
        `LaunchAgent state could not be inspected: ${reason}`,
        "openclaw gateway status --deep",
        "the LaunchAgent is installed but not loaded",
        "logged-in macOS user session",
      ]);
      expect(recover).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );
  it.each(["recovered", "failed", "unhealthy"] as const)(
    "records only attempted native repair before rechecking update health (%s)",
    async (outcome) => {
      const repaired = outcome !== "failed";
      const env = {
        OPENCLAW_STATE_DIR: tempDirs.make("update-native-repair-"),
        OPENCLAW_PROFILE: "stomme",
        OPENCLAW_PORT: "18790",
      };
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const service = {} as never;
      const unhealthy = stoppedHealth();
      const healthy = {
        ...unhealthy,
        runtime: { status: "running" as const, pid: 4242 },
        portUsage: { port: 18790, status: "busy" as const, listeners: [{ pid: 4242 }], hints: [] },
        healthy: true,
        gatewayVersion: "2026.5.3",
        waitOutcome: "healthy" as const,
      };
      const rechecked =
        outcome === "unhealthy" ? { ...unhealthy, waitOutcome: "timeout" as const } : healthy;
      const recovery = repaired
        ? ({ status: "recovered", message: recoveryMessage } as const)
        : ({ status: "failed", detail: "Bootstrap failed." } as const);
      vi.spyOn(launchAgentRecovery, "recoverInstalledLaunchAgentAfterUpdate").mockResolvedValue(
        recovery,
      );
      const waitForHealthy = vi
        .spyOn(restartHealth, "waitForGatewayHealthyRestart")
        .mockImplementation(async () => {
          if (outcome !== "unhealthy") {
            expect(getUpdateRun(runId, { env })?.repair).toMatchObject([{ status: "succeeded" }]);
          }
          return rechecked;
        });
      const startedAtMs = Date.now();

      await expect(
        recoverLaunchAgentAndRecheckGatewayHealth({
          ...(outcome === "unhealthy" ? {} : { updateRun: { runId, env } }),
          health: unhealthy,
          service,
          port: 18790,
          expectedVersion: "2026.5.3",
          expectedBuildId: "new-build",
          env,
        }),
      ).resolves.toEqual({
        health: repaired ? rechecked : unhealthy,
        launchAgentRecovery: recovery,
      });

      if (repaired) {
        expect(waitForHealthy).toHaveBeenCalledWith({
          service,
          port: 18790,
          expectedVersion: "2026.5.3",
          expectedBuildId: "new-build",
          env,
          supervisorKeepsAlive: true,
          requirePluginHealth: false,
          requireChannelHealth: false,
        });
      } else {
        expect(waitForHealthy).not.toHaveBeenCalled();
      }
      const repair = getUpdateRun(runId, { env })?.repair;
      if (outcome === "unhealthy") {
        expect(repair).toEqual([]);
      } else {
        expect(repair).toEqual([
          {
            attempt: 1,
            status: repaired ? "succeeded" : "failed",
            startedAtMs: expect.any(Number),
            endedAtMs: expect.any(Number),
            summary: repaired ? recoveryMessage : "Bootstrap failed.",
          },
        ]);
        expect(repair?.[0]?.startedAtMs).toBeGreaterThanOrEqual(startedAtMs);
        expect(repair?.[0]?.endedAtMs).toBeGreaterThanOrEqual(repair?.[0]?.startedAtMs ?? Infinity);
      }
    },
  );
});

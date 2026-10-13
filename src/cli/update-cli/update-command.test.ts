// Update command tests cover update command orchestration and filesystem effects.
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
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import { applyPostPluginConfigValidation } from "./update-command-post-plugin-validation.js";
import {
  resolveServiceRefreshEnv,
  resolveUpdateTargetEnv,
  resolveOwnedManagedUpdateEnv,
  resolveUpdatedInstallCommandEnv,
} from "./update-command-service-env.js";
import {
  formatPostUpdateGatewayRecoveryInstructions,
  recoverLaunchAgentAndRecheckGatewayHealth,
} from "./update-command-service-recovery.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

const tempDirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("applyPostPluginConfigValidation", () => {
  const pluginUpdate = {
    status: "ok",
    changed: true,
    sync: {
      changed: true,
      switchedToBundled: [],
      switchedToNpm: [],
      warnings: [],
      errors: [],
    },
    npm: { changed: true, outcomes: [] },
    integrityDrifts: [],
    warnings: [],
  } satisfies PostCorePluginUpdateResult;

  it("fails closed when updated plugin migrations leave config invalid", () => {
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
});

describe("resolveUpdatedGatewayRestartPort", () => {
  it("uses the managed service port ahead of the caller environment", async () => {
    expect(
      await resolveUpdatedGatewayRestartPort({
        config: { gateway: { port: 19000 } } as never,
        processEnv: { OPENCLAW_GATEWAY_PORT: "19001" },
        serviceEnv: { OPENCLAW_GATEWAY_PORT: "19002" },
      }),
    ).toBe(19002);
  });
});

describe("update environment snapshots", () => {
  it.each(["win32"] as const)(
    "preserves %s selector lookup semantics without retaining the live environment",
    (platform) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      try {
        const caller = {
          Home: "/caller/home",
          OpenClaw_State_Dir: "/caller/state",
          OpenClaw_Config_Path: "/caller/config.json",
          OpenClaw_Profile: "caller",
        };
        const snapshot = resolveServiceRefreshEnv(caller);
        caller.OpenClaw_State_Dir = "/later/state";
        if (platform === "win32") {
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
        }
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    },
  );
});

describe("resolveUpdateTargetEnv", () => {
  it("keeps the caller env when no managed service env is available", () => {
    const env = resolveUpdateTargetEnv({
      baseEnv: {
        PATH: "/bin",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_STATE_DIR: "/caller/state",
        OPENCLAW_PROFILE: "caller",
      },
    });

    expect(env.PATH).toBe("/bin");
    expect(env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
    expect(env.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(env.OPENCLAW_STATE_DIR).toBe("/caller/state");
    expect(env.OPENCLAW_PROFILE).toBe("caller");
  });
});

describe("resolveUpdatedInstallCommandEnv", () => {
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

    expect(env.OPENCLAW_GATEWAY_AUTH_TOKEN).toBe("runtime-token");
    expect(env.OPENCLAW_STATE_DIR).toBe(path.join("/srv/openclaw", "daemon-state"));
    expect(env.PATH).toBe("/daemon/bin");
    expect(env.OPENCLAW_HOME).toBe("/daemon/home");
    expect(env.OPENCLAW_PROFILE).toBe("work");
    expect(env).toMatchObject({
      TMPDIR: "/caller/cache",
      TMP: "/caller/tmp",
      TEMP: "/caller/temp",
    });
    expect(env.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(resolveUpdatedInstallCommandEnv({ processEnv: env })).toEqual(env);
  });
});

describe("formatPostUpdateGatewayRecoveryInstructions", () => {
  const result: UpdateRunResult = {
    status: "error",
    mode: "git",
    steps: [],
    durationMs: 0,
  };

  it("keeps LaunchAgent recovery wording on macOS", () => {
    const [line] = formatPostUpdateGatewayRecoveryInstructions(result, "darwin");

    expect(line).toContain("the LaunchAgent is installed but not loaded");
    expect(line).toContain("logged-in macOS user session");
  });
});

describe("recoverInstalledLaunchAgentAfterUpdate", () => {
  beforeEach(() => mockProcessPlatform("darwin"));
  afterEach(() => vi.restoreAllMocks());
  it("does not recover a loaded LaunchAgent", async () => {
    const service = createMockGatewayService();
    vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: false,
      env: {},
      command: null,
    });
    const recover = vi
      .spyOn(nativeLaunchAgentRecovery, "recoverInstalledLaunchAgent")
      .mockResolvedValue(null);

    await expect(
      launchAgentRecovery.recoverInstalledLaunchAgentAfterUpdate({ service }),
    ).resolves.toEqual({ status: "not-needed" });
    expect(recover).not.toHaveBeenCalled();
  });
  it.each(["recovered", "failed", "system owner"] as const)(
    "reports installed-but-not-loaded LaunchAgent recovery: %s",
    async (outcome) => {
      const service = createMockGatewayService();
      const serviceEnv = { OPENCLAW_PROFILE: "stomme" };
      const recoveredEnv = { ...serviceEnv, OPENCLAW_PORT: "18790" };
      const readState = vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue({
        installed: true,
        loadState: { status: "not-loaded" },
        running: false,
        env: recoveredEnv,
        command: null,
        runtime: { status: "stopped" },
      });
      const message =
        "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.";
      const guidance = "System LaunchDaemon system/ai.openclaw.stomme owns this label";
      const recover = vi
        .spyOn(nativeLaunchAgentRecovery, "recoverInstalledLaunchAgent")
        .mockImplementation(async ({ result }) => {
          if (outcome === "system owner") {
            throw new Error(guidance);
          }
          return outcome === "recovered" ? { result, loaded: true, message } : null;
        });

      await expect(
        launchAgentRecovery.recoverInstalledLaunchAgentAfterUpdate({
          service,
          env: serviceEnv,
        }),
      ).resolves.toEqual(
        outcome === "recovered"
          ? { status: "recovered", message }
          : {
              status: "failed",
              detail:
                outcome === "system owner"
                  ? guidance
                  : "LaunchAgent was installed but not loaded; automatic bootstrap/kickstart recovery failed.",
            },
      );
      expect(readState).toHaveBeenCalledWith(service, { env: serviceEnv });
      expect(recover).toHaveBeenCalledWith({ result: "restarted", env: recoveredEnv });
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
      mockProcessPlatform("darwin");
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("update-probe-failure-") };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const service = createMockGatewayService();
      const readState = vi.spyOn(gatewayService, "readGatewayServiceState");
      const reason = "launchctl denied";
      if (probe === "rejected") {
        readState.mockRejectedValue(new Error(reason));
      } else {
        readState.mockResolvedValue({
          installed: true,
          loadState: { status: "unknown", detail: reason },
          running: false,
          env,
          command: null,
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
        health: {
          runtime: { status: "stopped" },
          portUsage: { port: 18790, status: "free", listeners: [], hints: [] },
          healthy: false,
          staleGatewayPids: [],
          waitOutcome: "stopped-free",
        },
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
      expect(output.mock.calls.flat().join("\n")).toContain(
        `LaunchAgent state could not be inspected: ${reason}`,
      );
      expect(output.mock.calls.flat().join("\n")).toContain("openclaw gateway status --deep");
      expect(recover).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );
  it.each(["recovered", "failed"] as const)(
    "records only attempted native repair before rechecking update health (%s)",
    async (outcome) => {
      const env = {
        OPENCLAW_STATE_DIR: tempDirs.make("update-native-repair-"),
        OPENCLAW_PROFILE: "stomme",
        OPENCLAW_PORT: "18790",
      };
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const service = {} as never;
      const unhealthy = {
        runtime: { status: "stopped" },
        portUsage: { port: 18790, status: "free", listeners: [], hints: [] },
        healthy: false,
        staleGatewayPids: [],
        waitOutcome: "stopped-free",
      } as never;
      const healthy = {
        runtime: { status: "running", pid: 4242 },
        portUsage: { port: 18790, status: "busy", listeners: [{ pid: 4242 }], hints: [] },
        healthy: true,
        staleGatewayPids: [],
        gatewayVersion: "2026.5.3",
        waitOutcome: "healthy",
      } as never;
      const message =
        "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.";
      const recovery =
        outcome === "recovered"
          ? ({ status: "recovered", message } as const)
          : outcome === "failed"
            ? ({ status: "failed", detail: "Bootstrap failed." } as const)
            : ({ status: "not-needed" } as const);
      vi.spyOn(launchAgentRecovery, "recoverInstalledLaunchAgentAfterUpdate").mockResolvedValue(
        recovery,
      );
      const waitForHealthy = vi
        .spyOn(restartHealth, "waitForGatewayHealthyRestart")
        .mockImplementation(async () => {
          expect(getUpdateRun(runId, { env })?.repair).toMatchObject([{ status: "succeeded" }]);
          return healthy;
        });
      const startedAtMs = Date.now();

      await expect(
        recoverLaunchAgentAndRecheckGatewayHealth({
          updateRun: { runId, env },
          health: unhealthy,
          service,
          port: 18790,
          expectedVersion: "2026.5.3",
          expectedBuildId: "new-build",
          env,
        }),
      ).resolves.toEqual({
        health: outcome === "recovered" ? healthy : unhealthy,
        launchAgentRecovery: recovery,
      });

      if (outcome === "recovered") {
        expect(waitForHealthy).toHaveBeenCalledWith({
          service,
          port: 18790,
          expectedVersion: "2026.5.3",
          expectedBuildId: "new-build",
          env,
          supervisorKeepsAlive: true,
          requirePluginHealth: false,
          settle: { probes: 12 },
        });
      } else {
        expect(waitForHealthy).not.toHaveBeenCalled();
      }
      const repair = getUpdateRun(runId, { env })?.repair;
      {
        expect(repair).toEqual([
          {
            attempt: 1,
            status: outcome === "recovered" ? "succeeded" : "failed",
            startedAtMs: expect.any(Number),
            endedAtMs: expect.any(Number),
            summary: outcome === "recovered" ? message : "Bootstrap failed.",
          },
        ]);
        expect(repair?.[0]?.startedAtMs).toBeGreaterThanOrEqual(startedAtMs);
        expect(repair?.[0]?.endedAtMs).toBeGreaterThanOrEqual(repair?.[0]?.startedAtMs ?? Infinity);
      }
    },
  );

  it("keeps the update unhealthy when LaunchAgent repair succeeds but health does not recover", async () => {
    const service = {} as never;
    const unhealthySnapshot = {
      runtime: { status: "stopped" },
      portUsage: { port: 18790, status: "free", listeners: [], hints: [] },
      healthy: false,
      staleGatewayPids: [],
      waitOutcome: "stopped-free",
    };
    const unhealthy = unhealthySnapshot as never;
    const stillUnhealthy = {
      ...unhealthySnapshot,
      waitOutcome: "timeout",
    } as never;
    vi.spyOn(launchAgentRecovery, "recoverInstalledLaunchAgentAfterUpdate").mockResolvedValue({
      status: "recovered",
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    });
    vi.spyOn(restartHealth, "waitForGatewayHealthyRestart").mockResolvedValue(stillUnhealthy);

    const result = await recoverLaunchAgentAndRecheckGatewayHealth({
      health: unhealthy,
      service,
      port: 18790,
      expectedVersion: "2026.5.3",
    });
    expect(result.health.healthy).toBe(false);
    expect(result.health.waitOutcome).toBe("timeout");
    expect(result.launchAgentRecovery?.status).toBe("recovered");
  });
});

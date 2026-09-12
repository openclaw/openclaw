import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayService,
} from "../../daemon/service.js";
import { getUpdateRun, recordUpdateRunRepairAttempt } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  recoverInstalledLaunchAgentAfterUpdate,
  type PostUpdateLaunchAgentRecoveryResult,
} from "./update-command-launch-agent-recovery.js";
import {
  originalServiceAuthority,
  assertOriginalServiceStateCompatible,
  revalidateOriginalManagedServiceRuntime,
} from "./update-command-original-service.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import {
  isPackageManagerUpdateMode,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import type { OriginalManagedServiceRuntime } from "./update-command-service-context-types.js";
import {
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";

type PostUpdateGatewayHealthRecoveryDeps = {
  recoverLaunchAgent?: typeof recoverInstalledLaunchAgentAfterUpdate;
  waitForHealthy?: typeof waitForGatewayHealthyRestart;
};

export async function recoverLaunchAgentAndRecheckGatewayHealth(params: {
  updateRun?: UpdateCommandOptions["run"];
  assertCurrent?: () => void;
  preserveDefinition?: boolean;
  health: GatewayRestartSnapshot;
  service: GatewayService;
  port: number;
  timeoutMs?: number;
  expectedVersion?: string;
  expectedBuildId?: string;
  requirePluginHealth?: boolean;
  env?: NodeJS.ProcessEnv;
  deps?: PostUpdateGatewayHealthRecoveryDeps;
}): Promise<{
  health: GatewayRestartSnapshot;
  launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null;
}> {
  const executor = params.updateRun?.executorFence;
  const assertCurrent = () => {
    executor?.assertCurrent();
    params.assertCurrent?.();
  };
  assertCurrent();
  if (params.health.healthy || params.preserveDefinition) {
    return { health: params.health, launchAgentRecovery: null };
  }

  const recoverLaunchAgent =
    params.deps?.recoverLaunchAgent ?? recoverInstalledLaunchAgentAfterUpdate;
  const startedAtMs = Date.now();
  const launchAgentRecovery = await withGatewayServiceOperationLock(
    params.env ?? process.env,
    async (assertNative) => {
      const assertRecovery = () => {
        assertCurrent();
        assertNative();
      };
      assertRecovery();
      const recovery = await recoverLaunchAgent({
        service: params.service,
        env: params.env,
        assertCurrent: assertRecovery,
      });
      assertRecovery();
      return recovery;
    },
  );
  assertCurrent();
  // Native repair can succeed while readiness still fails; retain both observed outcomes.
  if (launchAgentRecovery.attempted && params.updateRun) {
    const endedAtMs = Date.now();
    const { runId, env } = params.updateRun;
    const repair = getUpdateRun(runId, { env })?.repair ?? [];
    recordUpdateRunRepairAttempt(
      runId,
      {
        attempt: Math.max(0, ...repair.map((entry) => entry.attempt)) + 1,
        status: launchAgentRecovery.recovered ? "succeeded" : "failed",
        startedAtMs,
        endedAtMs,
        summary: launchAgentRecovery.recovered
          ? launchAgentRecovery.message
          : launchAgentRecovery.detail,
      },
      { env },
    );
  }
  if (!launchAgentRecovery.recovered) {
    return { health: params.health, launchAgentRecovery };
  }

  const waitForHealthy = params.deps?.waitForHealthy ?? waitForGatewayHealthyRestart;
  const health = await waitForHealthy({
    service: params.service,
    port: params.port,
    timeoutMs: params.timeoutMs,
    expectedVersion: params.expectedVersion,
    ...(params.expectedBuildId ? { expectedBuildId: params.expectedBuildId } : {}),
    requirePluginHealth: params.requirePluginHealth,
    env: params.env,
    supervisorKeepsAlive: true,
    settle: { probes: 12 },
  });
  assertCurrent();
  return { health, launchAgentRecovery };
}

export async function hasLoadedLaunchdKeepAliveSupervisor(params: {
  service: GatewayService;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  // OpenClaw's loaded LaunchAgent has canonical KeepAlive policy. Read this once before
  // polling so an unloaded agent can still reach the existing recovery path promptly.
  return await params.service.isLoaded({ env: params.env }).catch(() => false);
}

function formatPostUpdateGatewayRecoveryLine(platform: NodeJS.Platform): string {
  const restartCommand = formatCliCommand("openclaw gateway restart");
  const installCommand = formatCliCommand("openclaw gateway install --force");
  const statusCommand = formatCliCommand("openclaw gateway status --deep");
  if (platform === "darwin") {
    return `Recovery: run \`${restartCommand}\`; if the LaunchAgent is installed but not loaded, run \`${installCommand}\` from the logged-in macOS user session, then rerun \`${statusCommand}\`.`;
  }
  if (platform === "linux") {
    return `Recovery: run \`${restartCommand}\`; if the systemd user service is missing, stale, or not active, run \`${installCommand}\` from the same user account, then rerun \`${statusCommand}\`.`;
  }
  if (platform === "win32") {
    return `Recovery: run \`${restartCommand}\`; if the gateway Scheduled Task or Windows login item is missing, stale, or not running, run \`${installCommand}\` from the same user account, then rerun \`${statusCommand}\`.`;
  }
  return `Recovery: run \`${restartCommand}\`; if the local service manager reports the gateway service is missing, stale, or not running, run \`${installCommand}\` from the same user account, then rerun \`${statusCommand}\`.`;
}

export function formatPostUpdateGatewayRecoveryInstructions(
  result: UpdateRunResult,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const lines = [formatPostUpdateGatewayRecoveryLine(platform)];
  const beforeVersion = normalizeOptionalString(result.before?.version);
  if (isPackageManagerUpdateMode(result.mode) && beforeVersion) {
    lines.push(
      `Rollback: reinstall OpenClaw ${beforeVersion} with the same package manager, then rerun \`${formatCliCommand("openclaw gateway install --force")}\`.`,
    );
  }
  return lines;
}

export async function maybeRestartServiceAfterFailedMutableUpdate(params: {
  updateRun?: UpdateCommandOptions["run"];
  preManagedServiceStop: PreManagedServiceStop | undefined;
  recovery?: UpdateRunResult["recovery"];
  originalManagedServiceRuntime?: OriginalManagedServiceRuntime;
  jsonMode: boolean;
  nodeRunner?: string;
  timeoutMs?: number;
  invocationCwd?: string;
}): Promise<"healthy" | "failed" | undefined> {
  const run = params.updateRun;
  const executor = run?.executorFence;
  const assertCurrent = () => {
    if (params.updateRun !== run || run?.executorFence !== executor || (run && !executor)) {
      throw new UpdateCommandRecoveryPendingError(
        "Service recovery lost its original update executor.",
      );
    }
    executor?.assertCurrent();
  };
  const before = params.preManagedServiceStop;
  if (!before?.stopped || !before.serviceEnv) {
    return undefined;
  }
  const original = params.originalManagedServiceRuntime;
  const packageRecovery =
    params.recovery?.serviceRestartSafe === true && params.recovery.version
      ? params.recovery
      : undefined;
  if (!original && !packageRecovery) {
    defaultRuntime.error(
      "Managed gateway remains stopped: update safety is unverified. Run `openclaw doctor` and inspect the update failure before restarting.",
    );
    return "failed";
  }
  assertCurrent();
  try {
    const verdict = before.serviceUpdateVerdict;
    if (!verdict || !("root" in verdict)) {
      throw new Error(
        "Stopped service ownership is unknown; restart it manually after inspection.",
      );
    }
    const assertOriginal = original ? originalServiceAuthority(run) : assertCurrent;
    const checkOriginal = async () => {
      assertCurrent();
      assertOriginal();
      if (original) {
        await assertOriginalServiceStateCompatible(original, assertOriginal);
        await revalidateOriginalManagedServiceRuntime(original, assertOriginal, params.timeoutMs);
      }
      assertCurrent();
    };
    await checkOriginal();
    const service = resolveGatewayService();
    let expectedService: Pick<
      PreManagedServiceStop,
      "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid"
    > = original?.service ?? before;
    const readCurrentService = async () => {
      assertCurrent();
      const state = await readGatewayServiceState(service, {
        env: before.serviceEnv,
        requireEffective: true,
        requireLoadedCommand: true,
        validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
        timeoutMs: params.timeoutMs,
      });
      assertCurrent();
      const inspection = await revalidateManagedGatewayServiceAfterUpdate({
        state,
        root: original?.root ?? verdict.root,
        preManagedServiceStop: expectedService,
      });
      assertCurrent();
      // Recovery preserves the current definition. Once observed, even a same-unit
      // replacement during config or health awaits must not inherit this activation.
      expectedService = {
        serviceManagerUid: before.serviceManagerUid,
        serviceEnv: state.env,
        serviceUpdateVerdict:
          inspection.kind === "owned" ? { ...inspection, refreshDefinition: false } : inspection,
      };
      return state;
    };
    const state = await readCurrentService();
    const port = await resolveUpdatedGatewayRestartPort({
      serviceEnv: state.env,
      serviceCommand: state.command,
    });
    assertCurrent();
    // Context resolution awaits config reads. Revalidate before the one activation;
    // the installed CLI owns its config dialect and preserves the service definition.
    const current = await readCurrentService();
    await checkOriginal();
    if (original) {
      await before.windowsTaskAutoStartRecovery?.restore(true, checkOriginal, assertOriginal);
      await checkOriginal();
    }
    await runUpdatedInstallGatewayCommand(
      {
        result: { root: original?.root ?? verdict.root },
        opts: { json: params.jsonMode, run },
        invocationEnv: before.serviceEnv,
        serviceEnv: current.env,
        nodeRunner: original?.nodeRunner ?? params.nodeRunner,
        timeoutMs: params.timeoutMs,
        invocationCwd: params.invocationCwd,
        assertCurrent,
      },
      "restart",
      true,
    );
    assertCurrent();
    const health = await waitForGatewayHealthyRestart({
      service,
      port,
      env: current.env,
      timeoutMs: params.timeoutMs,
      expectedVersion: original?.version ?? packageRecovery?.version,
      expectedBuildId: original?.buildId ?? packageRecovery?.buildId,
      requireRunningService: true,
      settle: { probes: 12 },
    });
    assertCurrent();
    if (!health.healthy || health.runtime.status !== "running") {
      throw new Error(renderRestartDiagnostics(health).join("\n"));
    }
    await readCurrentService();
    await checkOriginal();
    if (original) {
      try {
        // Settle A's native restoration independently of B's failed activation.
        await before.windowsTaskAutoStartRecovery?.complete(true);
        assertCurrent();
      } catch (cause) {
        throw new UpdateCommandRecoveryPendingError(
          "Original service autostart settlement failed.",
          { cause },
        );
      }
    }
    if (!params.jsonMode) {
      defaultRuntime.log(
        theme.muted(
          "Recovered managed gateway service and verified readiness after failed update.",
        ),
      );
    }
    return "healthy";
  } catch (err) {
    assertCurrent();
    if (err instanceof UpdateCommandRecoveryPendingError) {
      throw err;
    }
    defaultRuntime.error(
      `Failed to restart managed gateway service after failed update: ${String(err)}. Run \`openclaw gateway status --deep\` before restarting it manually.`,
    );
    return "failed";
  }
}

export async function compensateOriginalManagedService(
  params: {
    result: UpdateRunResult;
    opts: UpdateCommandOptions;
    preManagedServiceStop?: PreManagedServiceStop;
    originalManagedServiceRuntime?: OriginalManagedServiceRuntime;
    allowGatewayRestart?: boolean;
    timeoutMs: number;
    invocationCwd?: string;
  },
  assertCurrent: () => void,
): Promise<{
  result: UpdateRunResult;
  rolledBack: false;
  originalServiceRecovery: "healthy" | "failed";
}> {
  const original = params.originalManagedServiceRuntime;
  if (!original) {
    throw new Error("Original service observation is missing.");
  }
  const { result, opts, preManagedServiceStop: before } = params;
  const run = opts.run;
  // A is unchanged service code, not B's previous generation. Never reverse B
  // or its current state merely to compensate the stop of compatible A.
  const service =
    params.allowGatewayRestart === false
      ? undefined
      : await maybeRestartServiceAfterFailedMutableUpdate({
          updateRun: run,
          preManagedServiceStop: before,
          originalManagedServiceRuntime: original,
          jsonMode: Boolean(opts.json),
          timeoutMs: params.timeoutMs,
          invocationCwd: params.invocationCwd,
        });
  assertCurrent();
  return {
    result: {
      ...result,
      recovery: {
        ...result.recovery,
        serviceRestartSafe: false,
        reason:
          result.recovery?.serviceRestartSafe === false
            ? result.recovery.reason
            : "runtime-verification-failed",
      },
      steps: [
        ...result.steps,
        {
          name: "original managed service compensation",
          command: "openclaw gateway restart --preserve-definition",
          cwd: original.root,
          durationMs: 0,
          exitCode: service === "healthy" ? 0 : 1,
          ...(service === "healthy"
            ? {
                stdoutTail: `Original managed service ${original.version} is healthy. Requested package activation was not verified; package and state were retained.`,
              }
            : {
                stderrTail:
                  "Original managed service compensation was not verified; package and current state were retained.",
              }),
        },
      ],
    },
    rolledBack: false,
    originalServiceRecovery: service === "healthy" ? "healthy" : "failed",
  };
}

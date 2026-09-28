import { Writable } from "node:stream";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { resolveGatewayService, type GatewayService } from "../../daemon/service.js";
import { getUpdateRun, recordUpdateRunRepairAttempt } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
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
import { restoreOriginalManagedServiceDefinition } from "./update-command-original-service-restore.js";
import {
  originalServiceAuthority,
  assertOriginalServiceStateCompatible,
  revalidateOriginalManagedServiceRuntime,
} from "./update-command-original-service.js";
import { verifyPreviousGatewayForUpdate } from "./update-command-readiness.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  isPackageManagerUpdateMode,
  restartRetainedUpdateGatewayService,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import type { OriginalManagedServiceRuntime } from "./update-command-service-context-types.js";
import {
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import {
  readGatewayServiceStateForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";

const QUIET_SERVICE_STDOUT = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

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

function formatPostUpdateGatewayRecoveryLine(platform: NodeJS.Platform): string {
  const restartCommand = formatCliCommand("openclaw gateway restart");
  const installCommand = formatCliCommand("openclaw gateway install --force");
  const statusCommand = formatCliCommand("openclaw gateway status --deep");
  const condition =
    platform === "darwin"
      ? "LaunchAgent is installed but not loaded"
      : platform === "linux"
        ? "systemd user service is missing, stale, or not active"
        : platform === "win32"
          ? "gateway Scheduled Task or Windows login item is missing, stale, or not running"
          : "local service manager reports the gateway service is missing, stale, or not running";
  const session = platform === "darwin" ? "logged-in macOS user session" : "same user account";
  return `Recovery: run \`${restartCommand}\`; if the ${condition}, run \`${installCommand}\` from the ${session}, then rerun \`${statusCommand}\`.`;
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
  const original = params.originalManagedServiceRuntime;
  // An own-rebind receipt also proves an activation effect if final stop
  // inspection observed A already down and did not record a native stop.
  if (!before?.serviceEnv || (!before.stopped && !original?.definition.rebound)) {
    return undefined;
  }
  const serviceEnv = { ...(original?.service.serviceEnv ?? before.serviceEnv) };
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
    if (original && run) {
      await restoreOriginalManagedServiceDefinition({
        original,
        run,
        assertCurrent: assertOriginal,
        stdout: params.jsonMode ? QUIET_SERVICE_STDOUT : process.stdout,
        timeoutMs: params.timeoutMs,
      });
    }
    await checkOriginal();
    const service = resolveGatewayService();
    let expectedService: Pick<
      PreManagedServiceStop,
      "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid"
    > = original?.service ?? before;
    const readCurrentService = async () => {
      assertCurrent();
      const state = await readGatewayServiceStateForUpdate(service, serviceEnv, params.timeoutMs);
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
        serviceManagerUid: original?.service.serviceManagerUid ?? before.serviceManagerUid,
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
    // Executor capability does not bind an installed receiver's restart to A's
    // retained definition. Use the candidate owner, which revalidates that binding
    // under its final native-operation lock while retaining both A/B authorities.
    if (original && run) {
      const restart = await restartRetainedUpdateGatewayService({
        run,
        root: original.root,
        env: serviceEnv,
        stdout: params.jsonMode ? QUIET_SERVICE_STDOUT : process.stdout,
        assertCurrent: assertOriginal,
        revalidate: checkOriginal,
      });
      await checkOriginal();
      if (restart.outcome !== "completed") {
        throw new UpdateCommandRecoveryPendingError(
          "Original service restart was scheduled; recovery remains unverified.",
        );
      }
      // A platform owner may settle a previously suspended policy only after
      // admitted activation; the native path refuses unsupported Windows custody
      // before reaching this restoration. Recheck the retained identity throughout.
      await before.windowsTaskAutoStartRecovery?.restore(true, checkOriginal, assertOriginal);
      await checkOriginal();
    } else {
      await runUpdatedInstallGatewayCommand(
        {
          result: { root: original?.root ?? verdict.root },
          opts: { json: params.jsonMode, run },
          invocationEnv: serviceEnv,
          serviceEnv: current.env,
          nodeRunner: original?.nodeRunner ?? params.nodeRunner,
          timeoutMs: params.timeoutMs,
          invocationCwd: params.invocationCwd,
          assertCurrent,
        },
        "restart",
      );
    }
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
      const context = await assertOriginalServiceStateCompatible(original, assertOriginal);
      const ready = await verifyPreviousGatewayForUpdate({
        root: original.root,
        config: context.config,
        env: context.env,
        opts: { run },
        timeoutMs: params.timeoutMs,
        assertCurrent: assertOriginal,
      });
      await checkOriginal();
      if (!ready) {
        throw new Error("Original service independent readiness was not verified.");
      }
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
    if (hasCommandProcessCleanupError(err)) {
      throw err;
    }
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
  const healthy = service === "healthy";
  const summary = [
    healthy
      ? `Original managed service ${original.version} is healthy. Requested package activation was not verified; package and state were retained.`
      : "Original managed service compensation was not verified; package and current state were retained.",
    original.packageFingerprintWarning,
  ]
    .filter(Boolean)
    .join("\n");
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
          name: "original-managed-service-compensation",
          command: "openclaw gateway restart --preserve-definition",
          cwd: original.root,
          durationMs: 0,
          exitCode: healthy ? 0 : 1,
          ...(healthy ? { stdoutTail: summary } : { stderrTail: summary }),
        },
      ],
    },
    rolledBack: false,
    originalServiceRecovery: healthy ? "healthy" : "failed",
  };
}

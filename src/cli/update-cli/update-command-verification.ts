import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import type { UpdateRepairValidation } from "../../infra/update-repair-protocol.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { resolveGatewayRestartProbeContext } from "../daemon-cli/restart-health-probe.js";
import {
  inspectGatewayRestart,
  isSameGatewayRestartGeneration,
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { PostUpdateLaunchAgentRecoveryResult } from "./update-command-launch-agent-recovery.js";
import {
  createPluginUpdateWarning,
  type PluginUpdateWarning,
} from "./update-command-plugins-internals.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import {
  gatewayServiceCommandUsesRoot,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import {
  formatPostUpdateGatewayRecoveryInstructions,
  hasLoadedLaunchdKeepAliveSupervisor,
} from "./update-command-service-recovery.js";

export async function verifyPreviousGatewayForUpdate(params: {
  root: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const { config, env } = params;
  const port = await resolveUpdatedGatewayRestartPort({ config, serviceEnv: env });
  const [expectedVersion, expectedBuildId] = await Promise.all([
    readPackageVersion(params.root),
    readBuiltGatewayBuildId(params.root),
  ]);
  const [health, readiness, servesPreviousPackage] = await Promise.all([
    inspectGatewayRestart({
      service: resolveGatewayService(),
      env,
      port,
      expectedVersion,
      expectedBuildId: expectedBuildId ?? undefined,
      requirePluginHealth: false,
    }),
    waitForGatewayHttpReadiness({
      config,
      port,
      deadlineAt: Date.now() + 3_000,
      attempts: 1,
      delayMs: 0,
    }),
    gatewayServiceCommandUsesRoot({ root: params.root, env }),
  ]);
  return Boolean(
    expectedVersion &&
    servesPreviousPackage === true &&
    health.healthy &&
    health.runtime.status === "running" &&
    readiness.readyz === 200,
  );
}

export function recordUpdateGatewayHealth(
  run: UpdateCommandOptions["run"],
  health: GatewayRestartSnapshot,
  port: number,
  readyz = false,
): void {
  if (!run) {
    return;
  }
  recordUpdateRunVerification(
    run.runId,
    {
      serviceRunning: health.runtime.status === "running",
      ...(typeof health.runtime.pid === "number" ? { pid: health.runtime.pid } : {}),
      port,
      ...(health.gatewayVersion ? { runningVersion: health.gatewayVersion } : {}),
      ...(health.gatewayBuildId ? { runningBuildId: health.gatewayBuildId } : {}),
      ...(health.expectedVersion
        ? {
            versionMatch:
              health.gatewayVersion === health.expectedVersion && !health.buildIdMismatch,
          }
        : {}),
      pluginErrors: [
        ...(health.activatedPluginErrors?.map((error) => JSON.stringify(error)) ?? []),
        ...(health.unavailablePlugins?.map((error) => JSON.stringify(error)) ?? []),
      ],
      channelsReady: health.healthy && !health.channelProbeErrors?.length,
      settled: health.healthy,
      readyz,
    },
    { env: run.env },
  );
}

/** Verify core activation while preserving plugin failures as separate notices. */
export async function verifyUpdatedGateway(params: {
  result: UpdateRunResult;
  opts: UpdateCommandOptions;
  serviceEnv: NodeJS.ProcessEnv;
  gatewayPort: number;
  timeoutMs?: number;
  nodeRunner?: string;
  expectedVersion?: string;
  expectedBuildId?: string;
  requireRunningService?: boolean;
  health?: GatewayRestartSnapshot;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onVerified?: (verifiedAtMs: number) => void;
  recoverHealth?: (
    health: GatewayRestartSnapshot,
    reinspect: () => Promise<GatewayRestartSnapshot>,
  ) => Promise<{
    health: GatewayRestartSnapshot;
    launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null;
  }>;
}): Promise<UpdateRepairValidation & { pluginWarnings?: PluginUpdateWarning[] }> {
  // Readiness belongs to the original live executor through every awaited probe.
  const originalRun = params.opts.run;
  const originalExecutor = originalRun?.executorFence;
  const originalRecovery = params.opts.recovery;
  const proofOptions = {
    ...params.opts,
    ...(originalRun ? { run: { ...originalRun, env: { ...originalRun.env } } } : {}),
  };
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    if (
      params.opts.run !== originalRun ||
      originalRun?.executorFence !== originalExecutor ||
      params.opts.recovery !== originalRecovery
    ) {
      throw new UpdateCommandRecoveryPendingError("Readiness observation lost its admitted owner.");
    }
    originalExecutor?.assertCurrent();
    if (originalRecovery) {
      throw new UpdateCommandRecoveryPendingError(
        "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
      );
    }
  };
  assertCurrent();
  const service = resolveGatewayService();
  const probeParams = {
    service,
    port: params.gatewayPort,
    expectedVersion: params.expectedVersion,
    ...(params.expectedBuildId ? { expectedBuildId: params.expectedBuildId } : {}),
    requirePluginHealth: false,
    env: params.serviceEnv,
    ...(params.signal ? { signal: params.signal } : {}),
  };
  const waitForHealthy = async () => {
    assertCurrent();
    const supervisorKeepsAlive = await hasLoadedLaunchdKeepAliveSupervisor({
      service,
      env: params.serviceEnv,
    });
    assertCurrent();
    const health = await waitForGatewayHealthyRestart({
      ...probeParams,
      timeoutMs: params.timeoutMs,
      requireRunningService: params.requireRunningService,
      settle: { probes: 12 },
      supervisorKeepsAlive,
    });
    assertCurrent();
    return health;
  };
  let health = params.health ?? (await waitForHealthy());
  let launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null = null;
  if (params.recoverHealth) {
    ({ health, launchAgentRecovery } = await params.recoverHealth(health, waitForHealthy));
    assertCurrent();
  }
  const context = await resolveGatewayRestartProbeContext(params.serviceEnv);
  assertCurrent();
  const http = await waitForGatewayHttpReadiness({
    config: context.config,
    port: params.gatewayPort,
    attempts: 3,
    deadlineAt: Date.now() + 10_000,
    delayMs: 500,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  assertCurrent();
  const readyz = http.readyz === 200;
  if (
    health.healthy &&
    readyz &&
    (!params.requireRunningService || health.runtime.status === "running")
  ) {
    // HTTP readiness cannot transfer an earlier settle to a replacement boot.
    const settled = health;
    const inspected = await inspectGatewayRestart({ ...probeParams, probeContext: context });
    assertCurrent();
    // Bracket the final native observation with health/hello probes so a same-PID
    // or PID-less reboot during that observation cannot inherit the old boot.
    health = inspected.healthy
      ? await inspectGatewayRestart({ ...probeParams, probeContext: context })
      : inspected;
    assertCurrent();
    const sameGeneration =
      isSameGatewayRestartGeneration(settled, inspected) &&
      isSameGatewayRestartGeneration(inspected, health);
    if (!sameGeneration) {
      health.healthy = false;
      health.probeError = "Gateway process changed during final readiness verification.";
    }
  }
  if (launchAgentRecovery?.attempted) {
    defaultRuntime.error(
      launchAgentRecovery.recovered ? launchAgentRecovery.message : launchAgentRecovery.detail,
    );
  }
  const serviceRunning = !params.requireRunningService || health.runtime.status === "running";
  if (health.healthy && serviceRunning && readyz) {
    const pluginFailures = new Map<string, string>();
    for (const failure of health.activatedPluginErrors ?? []) {
      pluginFailures.set(failure.id, failure.error);
    }
    for (const failure of health.unavailablePlugins ?? []) {
      pluginFailures.set(failure.id, `${failure.reason}: ${failure.detail}`);
    }
    const pluginWarnings = Array.from(pluginFailures, ([pluginId, reason]) =>
      createPluginUpdateWarning({ pluginId, reason, kind: "load", env: params.serviceEnv }),
    );
    assertCurrent();
    const verifiedAtMs = Date.now();
    recordUpdateGatewayHealth(proofOptions.run, health, params.gatewayPort, readyz);
    params.onVerified?.(verifiedAtMs);
    assertCurrent();
    if (params.opts.run) {
      recordUpdateRunStep(
        params.opts.run.runId,
        { step: "gateway verification", status: "completed", endedAtMs: Date.now() },
        { env: params.opts.run.env },
      );
    }

    if (!params.opts.json) {
      defaultRuntime.log(theme.success("Gateway: restarted and verified."));
      for (const warning of pluginWarnings) {
        defaultRuntime.log(theme.warn(warning.message));
      }
    }
    return {
      ok: true,
      score: 7,
      summary:
        pluginWarnings.length > 0
          ? "Gateway service, version, channels, and readiness verified; plugin failures need a retry."
          : "Gateway service, version, plugins, channels, and readiness verified.",
      ...(pluginWarnings.length > 0 ? { pluginWarnings } : {}),
    };
  }
  recordUpdateGatewayHealth(proofOptions.run, health, params.gatewayPort, readyz);
  const diagnosticLines: [string, ...string[]] = [
    "Gateway did not become healthy after restart.",
    ...(!readyz ? ["Gateway /readyz did not return HTTP 200."] : []),
    ...(health.healthy && params.requireRunningService
      ? ["Gateway responded, but the managed service did not report running after restart."]
      : []),
    ...renderRestartDiagnostics(health),
    ...(launchAgentRecovery?.attempted
      ? [
          launchAgentRecovery.recovered
            ? `LaunchAgent recovery: ${launchAgentRecovery.message}`
            : `LaunchAgent recovery failed: ${launchAgentRecovery.detail}`,
        ]
      : []),
    `Restart log: ${resolveGatewayRestartLogPath(params.serviceEnv)}`,
    `Run \`${formatCliCommand("openclaw gateway status --deep")}\` for details.`,
    ...formatPostUpdateGatewayRecoveryInstructions(params.result),
  ];
  const reason = health.versionMismatch
    ? "version-mismatch"
    : health.buildIdMismatch
      ? "build-id-mismatch"
      : health.activatedPluginErrors?.length
        ? "plugin-errors"
        : health.channelProbeErrors?.length
          ? "channel-errors"
          : !readyz
            ? "readyz-unhealthy"
            : !serviceRunning
              ? "service-not-running"
              : (health.waitOutcome ?? "restart-unhealthy");
  if (params.opts.run) {
    recordUpdateRunStep(
      params.opts.run.runId,
      {
        step: "gateway verification",
        status: "failed",
        endedAtMs: Date.now(),
        detail: !readyz ? "Gateway /readyz did not return HTTP 200." : reason,
      },
      { env: params.opts.run.env },
    );
  }
  if (params.opts.json) {
    defaultRuntime.error(diagnosticLines.join("\n"));
  } else {
    defaultRuntime.log(theme.warn(diagnosticLines[0]));
    for (const line of diagnosticLines.slice(1)) {
      defaultRuntime.log(theme.muted(line));
    }
  }
  const score = [
    serviceRunning,
    !health.versionMismatch,
    !health.buildIdMismatch,
    !health.activatedPluginErrors?.length,
    !health.channelProbeErrors?.length,
    health.healthy,
    readyz,
  ].filter(Boolean).length;
  return { ok: false, score, summary: reason };
}

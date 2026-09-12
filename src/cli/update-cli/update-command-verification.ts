import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { STARTUP_MIGRATION_LEASE_TTL_MS } from "../../infra/startup-migration-checkpoint.js";
import {
  normalizeUpdateFailureFacts,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import type { UpdateRepairValidation } from "../../infra/update-repair-protocol.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult, UpdateStepResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { resolveGatewayRestartProbeContext } from "../daemon-cli/restart-health-probe.js";
import { DEFAULT_RESTART_HEALTH_DELAY_MS } from "../daemon-cli/restart-health.constants.js";
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
  opts: UpdateCommandOptions;
  timeoutMs?: number;
  observedStartupMs?: number;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const { config, env } = params;
  const readiness = captureUpdateGatewayReadinessOwner({ opts: params.opts });
  const assertCurrent = () => {
    readiness.assertCurrent();
    params.assertCurrent?.();
  };
  const port = await resolveUpdatedGatewayRestartPort({ config, serviceEnv: env });
  const [expectedVersion, expectedBuildId] = await Promise.all([
    readPackageVersion(params.root),
    readBuiltGatewayBuildId(params.root),
  ]);
  const { health, readyz } = await observeUpdateGatewayReadiness({
    serviceEnv: env,
    gatewayPort: port,
    expectedVersion: expectedVersion ?? undefined,
    expectedBuildId: expectedBuildId ?? undefined,
    timeoutMs: params.timeoutMs,
    observedStartupMs: params.observedStartupMs,
    requireRunningService: true,
    settle: { probes: 1 },
    assertCurrent,
  });
  const servesPreviousPackage = await gatewayServiceCommandUsesRoot({ root: params.root, env });
  assertCurrent();
  return Boolean(
    expectedVersion &&
    servesPreviousPackage === true &&
    health.healthy &&
    health.runtime.status === "running" &&
    readyz,
  );
}

export function recordPreviousGatewayVerification(
  run: UpdateCommandOptions["run"],
  verified: boolean,
): void {
  if (!run) {
    return;
  }
  recordUpdateRunStep(
    run.runId,
    {
      step: "previous gateway verification",
      status: "completed",
      detail: verified
        ? "Previous package is running and ready."
        : "Previous gateway was not verified; automatic rollback cannot restart it.",
      endedAtMs: Date.now(),
    },
    { env: run.env },
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

/** Keep readiness proof and its live authority bound to the original admission. */
export function captureUpdateGatewayReadinessOwner(params: {
  opts: UpdateCommandOptions;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}) {
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
      throw new UpdateCommandRecoveryPendingError(
        "Readiness observation lost its original executor.",
      );
    }
    originalExecutor?.assertCurrent();
    if (originalRecovery) {
      throw new UpdateCommandRecoveryPendingError(
        "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
      );
    }
  };
  return { proofOptions, assertCurrent };
}

type UpdateGatewayReadinessParams = {
  serviceEnv: NodeJS.ProcessEnv;
  gatewayPort: number;
  timeoutMs?: number;
  observedStartupMs?: number;
  expectedVersion?: string;
  expectedBuildId?: string;
  requireRunningService?: boolean;
  health?: GatewayRestartSnapshot;
  settle?: { probes: number };
  signal?: AbortSignal;
  assertCurrent?: () => void;
  recoverHealth?: (
    health: GatewayRestartSnapshot,
    reinspect: () => Promise<GatewayRestartSnapshot>,
  ) => Promise<{
    health: GatewayRestartSnapshot;
    launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null;
  }>;
};

/** Observe one ready generation before activation or after restart, without recording a verdict. */
export async function observeUpdateGatewayReadiness(params: UpdateGatewayReadinessParams) {
  // The canary measures this host's startup; leave tenfold IO headroom without shortening
  // the existing startup watchdog or overriding an operator's explicit allowance.
  const timeoutMs =
    params.timeoutMs ??
    Math.max(STARTUP_MIGRATION_LEASE_TTL_MS, (params.observedStartupMs ?? 0) * 10);
  const settle = params.settle ?? { probes: 12 };
  const settleDurationMs = (Math.max(1, settle.probes) - 1) * DEFAULT_RESTART_HEALTH_DELAY_MS;
  const startedAtMs = performance.now();
  const remainingMs = () =>
    Math.max(0, timeoutMs + settleDurationMs - (performance.now() - startedAtMs));
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
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
      // The restart owner adds settling itself; reserve it once in the shared deadline.
      timeoutMs: Math.max(1, remainingMs() - settleDurationMs),
      requireRunningService: params.requireRunningService,
      settle,
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
  if (
    !health.healthy &&
    ((health.waitOutcome !== undefined && health.waitOutcome !== "healthy") ||
      health.versionMismatch ||
      health.buildIdMismatch ||
      health.activatedPluginErrors?.length ||
      health.channelProbeErrors?.length ||
      health.staleGatewayPids.length > 0)
  ) {
    return { health, readyz: false, readyzStatus: undefined, launchAgentRecovery };
  }
  const context = await resolveGatewayRestartProbeContext(params.serviceEnv);
  assertCurrent();
  const http = await waitForGatewayHttpReadiness({
    config: context.config,
    port: params.gatewayPort,
    attempts: Math.ceil(remainingMs() / DEFAULT_RESTART_HEALTH_DELAY_MS),
    deadlineAt: Date.now() + remainingMs(),
    probeTimeoutMs: remainingMs(),
    delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
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
    const inspect = () =>
      inspectGatewayRestart({
        ...probeParams,
        probeContext: context,
        timeoutMs: Math.max(1, remainingMs()),
      });
    const inspected = await inspect();
    assertCurrent();
    // Bracket the final native observation with health/hello probes so a same-PID
    // or PID-less reboot during that observation cannot inherit the old boot.
    health = inspected.healthy ? await inspect() : inspected;
    assertCurrent();
    const sameGeneration =
      isSameGatewayRestartGeneration(settled, inspected) &&
      isSameGatewayRestartGeneration(inspected, health);
    if (!sameGeneration) {
      health.healthy = false;
      health.probeError = "Gateway process changed during final readiness verification.";
    }
  }
  if (remainingMs() === 0) {
    health = { ...health, healthy: false, waitOutcome: "timeout" };
  }
  return { health, readyz, readyzStatus: http.readyz, launchAgentRecovery };
}

/** Verify core activation while preserving plugin failures as separate notices. */
export async function verifyUpdatedGateway(
  params: UpdateGatewayReadinessParams & {
    result: UpdateRunResult;
    opts: UpdateCommandOptions;
    nodeRunner?: string;
    onVerified?: (verifiedAtMs: number) => void;
  },
): Promise<UpdateRepairValidation & { pluginWarnings?: PluginUpdateWarning[] }> {
  const startedAtMs = Date.now();
  const { proofOptions, assertCurrent } = captureUpdateGatewayReadinessOwner(params);
  const { health, readyz, readyzStatus, launchAgentRecovery } = await observeUpdateGatewayReadiness({
    ...params,
    assertCurrent,
  });
  if (launchAgentRecovery?.attempted) {
    defaultRuntime.error(
      launchAgentRecovery.recovered ? launchAgentRecovery.message : launchAgentRecovery.detail,
    );
  }
  const serviceRunning = !params.requireRunningService || health.runtime.status === "running";
  const recordVerificationStep = (failureFacts?: UpdateFailureFact[], detail?: string) => {
    const endedAtMs = Date.now();
    const step: UpdateStepResult = {
      name: params.result.recovery?.packageRollbackVerified
        ? "rollback gateway verification"
        : "gateway verification",
      command: "gateway verification",
      cwd: params.result.root ?? process.cwd(),
      durationMs: endedAtMs - startedAtMs,
      exitCode: failureFacts ? 1 : 0,
      ...(failureFacts ? { failureFacts } : {}),
    };
    // Repair reuses the result: the last observation replaces its earlier failure.
    const index = params.result.steps.findIndex((entry) => entry.name === step.name);
    if (index === -1) {
      if (failureFacts) {
        params.result.steps.push(step);
      }
    } else {
      params.result.steps[index] = step;
    }
    if (proofOptions.run) {
      recordUpdateRunStep(
        proofOptions.run.runId,
        {
          step: step.name,
          status: failureFacts ? "failed" : "completed",
          endedAtMs,
          detail,
          failureFacts,
        },
        { env: proofOptions.run.env },
      );
    }
  };
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
    recordVerificationStep();

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
  const facts: UpdateFailureFact[] = [];
  if (health.versionMismatch) {
    facts.push({
      check: "versionMatch",
      code: "version-mismatch",
      message: `Expected Gateway version ${health.versionMismatch.expected}; observed ${health.versionMismatch.actual ?? "unavailable"}.`,
    });
  }
  if (health.buildIdMismatch) {
    facts.push({
      check: "versionMatch",
      code: "build-id-mismatch",
      message: `Expected Gateway build ${health.buildIdMismatch.expected}; observed ${health.buildIdMismatch.actual ?? "unavailable"}.`,
    });
  }
  if (!readyz) {
    facts.push({
      check: "readyz",
      code: "readyz-unhealthy",
      message: `Gateway readiness endpoint returned HTTP ${readyzStatus ?? "unavailable"}; expected HTTP 200.`,
    });
  }
  if (!serviceRunning) {
    facts.push({
      check: "service",
      code: "service-not-running",
      message: `Managed Gateway service status: ${health.runtime.status ?? "unknown"}.`,
    });
  }
  for (const error of health.activatedPluginErrors ?? []) {
    facts.push({
      check: "pluginErrors",
      code: "plugin-errors",
      pluginId: error.id,
      message: error.error,
    });
  }
  for (const error of health.channelProbeErrors ?? []) {
    facts.push({
      check: "channelsReady",
      code: "channel-errors",
      pluginId: error.id,
      message: error.error,
    });
  }
  if (!facts.length) {
    facts.push({
      check: "settled",
      code: health.waitOutcome ?? "restart-unhealthy",
      message:
        health.probeError ??
        `Gateway did not settle${health.startupPhase ? `; startup phase: ${health.startupPhase}` : "."}`,
    });
  }
  recordVerificationStep(
    normalizeUpdateFailureFacts(facts, params.serviceEnv),
    !readyz ? "Gateway /readyz did not return HTTP 200." : reason,
  );
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

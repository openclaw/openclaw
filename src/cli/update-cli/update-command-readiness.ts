import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { STARTUP_MIGRATION_LEASE_TTL_MS } from "../../infra/startup-migration-checkpoint.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { resolveGatewayRestartProbeContext } from "../daemon-cli/restart-health-probe.js";
import { DEFAULT_RESTART_HEALTH_DELAY_MS } from "../daemon-cli/restart-health.constants.js";
import {
  inspectGatewayRestart,
  isSameGatewayRestartGeneration,
  waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { PostUpdateLaunchAgentRecoveryResult } from "./update-command-launch-agent-recovery.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import {
  gatewayServiceCommandUsesRoot,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import { hasLoadedLaunchdKeepAliveSupervisor } from "./update-command-supervisor.js";

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

export type UpdateGatewayReadinessParams = {
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
    return { health, readyz: false, http: undefined, launchAgentRecovery };
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
  return { health, readyz, http, launchAgentRecovery };
}

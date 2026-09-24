import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { STARTUP_MIGRATION_LEASE_TTL_MS } from "../../infra/startup-migration-checkpoint.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunStep } from "../../infra/update-run-record.js";
import { redactSupportDiagnosticLine } from "../../logging/diagnostic-support-redaction.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createGatewayRestartDeadline,
  GatewayRestartDeadlineError,
} from "../daemon-cli/restart-health-deadline.js";
import {
  GATEWAY_RESTART_PROBE_TIMEOUT_MS,
  resolveGatewayRestartProbeContext,
} from "../daemon-cli/restart-health-probe.js";
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
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  gatewayServiceCommandUsesRoot,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import { hasLoadedLaunchdKeepAliveSupervisor } from "./update-command-supervisor.js";

// The startup watchdog supplies the floor; ×10 leaves slow-disk headroom.
// One hour bounds implicit observation of an already-serving Gateway; --timeout wins.
const PREVIOUS_GATEWAY_READINESS_CAP_MS = 60 * 60_000;

function readinessTimeoutMs(
  params: { timeoutMs?: number; observedStartupMs?: number },
  capMs = Infinity,
) {
  return (
    params.timeoutMs ??
    Math.min(capMs, Math.max(STARTUP_MIGRATION_LEASE_TTL_MS, (params.observedStartupMs ?? 0) * 10))
  );
}

export async function verifyPreviousGatewayForUpdate(params: {
  root: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  opts: UpdateCommandOptions;
  timeoutMs?: number;
  observedStartupMs?: number;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  requirePluginHealth?: boolean;
  expectedVersion?: string;
  gatewayPort?: number;
}): Promise<boolean> {
  const { config, env } = params;
  const { assertCurrent, proofOptions } = captureUpdateGatewayReadinessOwner(params);
  const run = proofOptions.run;
  const timeoutMs = readinessTimeoutMs(params, PREVIOUS_GATEWAY_READINESS_CAP_MS);
  const derivation =
    params.timeoutMs === undefined
      ? `min(${PREVIOUS_GATEWAY_READINESS_CAP_MS}ms, max(${STARTUP_MIGRATION_LEASE_TTL_MS}ms, canary startup ${params.observedStartupMs ?? 0}ms × 10))`
      : "explicit --timeout";
  const startedAtMs = Date.now();
  const deadline = createGatewayRestartDeadline({ timeoutMs, signal: params.signal });
  let lastProgress = { stage: "", at: -Infinity };
  let lastReason = "resolving the previous Gateway port and installed version";
  const progress = (stage: string, reason: string, warning = false) => {
    if (!warning) {
      deadline.signal.throwIfAborted();
    }
    assertCurrent();
    lastReason = reason;
    const now = performance.now();
    if (!warning && stage === lastProgress.stage && now - lastProgress.at < 30_000) {
      return;
    }
    lastProgress = { stage, at: now };
    const outcome = warning
      ? `Ended (${stage}); continuing with readiness unverified; automatic rollback cannot restart it. Run openclaw gateway status --deep --require-rpc to inspect it.`
      : `Remaining ${Math.ceil(deadline.remainingMs())}ms.`;
    const detail = `Previous-Gateway readiness verification: service, listener identity, version/build, health RPC and /readyz. Budget ${timeoutMs}ms (${derivation}). ${outcome} Last observation: ${redactSupportDiagnosticLine(reason, { env, stateDir: resolveStateDir(env) })}`;
    const fact: UpdateRunStep = {
      step: `${warning ? "warning:" : ""}previous gateway verification`,
      status: warning ? "completed" : "in_progress",
      startedAtMs,
      ...(warning ? { endedAtMs: Date.now() } : {}),
      detail,
    };
    if (run) {
      recordUpdateRunStep(run.runId, fact, { env: run.env });
    }
    defaultRuntime[params.opts.json ? "error" : "log"](`${fact.step}: ${detail}`);
  };
  try {
    progress("setup", lastReason);
    return await deadline.read("previous Gateway verification", async () => {
      const port =
        params.gatewayPort ?? (await resolveUpdatedGatewayRestartPort({ config, serviceEnv: env }));
      const [installedVersion, expectedBuildId] = await Promise.all([
        readPackageVersion(params.root),
        readBuiltGatewayBuildId(params.root),
      ]);
      if (params.expectedVersion && installedVersion !== params.expectedVersion) {
        return false;
      }
      const expectedVersion = params.expectedVersion ?? installedVersion;
      progress("readiness", `checking service and listener identity on port ${port}`);
      const { health, readyz } = await observeUpdateGatewayReadiness({
        serviceEnv: env,
        gatewayPort: port,
        expectedVersion: expectedVersion ?? undefined,
        expectedBuildId: expectedBuildId ?? undefined,
        timeoutMs,
        deadlineMs: deadline.deadlineMs,
        requireRunningService: true,
        settle: { probes: 1 },
        signal: deadline.signal,
        requirePluginHealth: params.requirePluginHealth,
        assertCurrent,
        onProgress: progress,
      });
      if (health.waitOutcome === "timeout" || health.waitOutcome === "still-starting") {
        progress(health.waitOutcome, lastReason, true);
        return false;
      }
      progress(
        "installation",
        "checking the managed service command still owns the previous installation",
      );
      const servesPreviousPackage = await gatewayServiceCommandUsesRoot({ root: params.root, env });
      assertCurrent();
      return Boolean(
        expectedVersion &&
        servesPreviousPackage === true &&
        health.healthy &&
        health.runtime.status === "running" &&
        readyz,
      );
    });
  } catch (error) {
    if (!(error instanceof GatewayRestartDeadlineError)) {
      throw error;
    }
    progress("budget exhausted", lastReason, true);
    return false;
  } finally {
    deadline.dispose();
  }
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
  deadlineMs?: number;
  onProgress?: (stage: string, reason: string) => void;
  observedStartupMs?: number;
  expectedVersion?: string;
  expectedBuildId?: string;
  requireRunningService?: boolean;
  requirePluginHealth?: boolean;
  health?: GatewayRestartSnapshot;
  /** A failure before activation observes existing health without waiting for startup. */
  waitForStartup?: boolean;
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

export function gatewayReadinessPending(health: GatewayRestartSnapshot): boolean {
  if (health.waitOutcome === "still-starting") {
    return true;
  }
  return (
    health.waitOutcome === "timeout" &&
    health.runtime.status === "running" &&
    (typeof health.runtime.pid === "number" || Boolean(health.gatewayBootId)) &&
    // Only the restart owner can establish startup; an HTTP failure is not progress.
    ["waiting for Gateway listener", "startup migration", "settling healthy Gateway"].includes(
      health.startupPhase ?? "",
    ) &&
    !health.versionMismatch &&
    !health.buildIdMismatch &&
    !health.activatedPluginErrors?.length &&
    !health.channelProbeErrors?.length &&
    health.staleGatewayPids.length === 0
  );
}

/** Observe one ready generation before activation or after restart, without recording a verdict. */
export async function observeUpdateGatewayReadiness(params: UpdateGatewayReadinessParams) {
  const waitForStartup = params.waitForStartup !== false;
  const timeoutMs = readinessTimeoutMs(params);
  const settle = params.settle ?? { probes: 12 };
  const settleDurationMs = waitForStartup
    ? (Math.max(1, settle.probes) - 1) * DEFAULT_RESTART_HEALTH_DELAY_MS
    : 0;
  const startedAtMs = performance.now();
  const remainingMs = () =>
    Math.max(
      0,
      Math.min(startedAtMs + timeoutMs + settleDurationMs, params.deadlineMs ?? Infinity) -
        performance.now(),
    );
  const probeTimeoutMs = () =>
    waitForStartup && params.deadlineMs === undefined
      ? remainingMs()
      : Math.min(remainingMs(), GATEWAY_RESTART_PROBE_TIMEOUT_MS);
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
    requirePluginHealth: params.requirePluginHealth ?? false,
    env: params.serviceEnv,
    ...(params.signal ? { signal: params.signal } : {}),
  };
  const readHealth = async () => {
    assertCurrent();
    if (!waitForStartup) {
      const health = await inspectGatewayRestart({
        ...probeParams,
        timeoutMs: Math.max(1, probeTimeoutMs()),
      });
      assertCurrent();
      return health;
    }
    const supervisorKeepsAlive = await hasLoadedLaunchdKeepAliveSupervisor({
      service,
      env: params.serviceEnv,
    });
    assertCurrent();
    const health = await waitForGatewayHealthyRestart({
      ...probeParams,
      // The restart owner adds settling itself; reserve it once in the shared deadline.
      timeoutMs: Math.max(1, remainingMs() - settleDurationMs),
      deadlineMs: params.deadlineMs,
      probeTimeoutMs: params.deadlineMs !== undefined ? 5_000 : undefined,
      onObservation: (snapshot) =>
        params.onProgress?.(
          "readiness",
          `${snapshot.startupPhase}; service=${snapshot.runtime.status} PID=${snapshot.runtime.pid ?? "unknown"}${snapshot.runtime.inspectionFailure ? `; native inspection=${snapshot.runtime.inspectionFailure.timeoutMs === undefined ? "unavailable" : `timed out (${snapshot.runtime.inspectionFailure.timeoutMs}ms)`}` : ""}; listener=${snapshot.portUsage.status}; listener PIDs=${snapshot.portUsage.listeners.map(({ pid }) => pid ?? "unknown").join(",") || "none"}; health=${snapshot.healthy ? "ready" : "unverified"}${snapshot.probeError ? `; ${snapshot.probeError}` : ""}`,
        ),
      requireRunningService: params.requireRunningService,
      settle,
      supervisorKeepsAlive,
    });
    assertCurrent();
    return health;
  };
  let health = params.health ?? (await readHealth());
  let launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null = null;
  if (params.recoverHealth && !gatewayReadinessPending(health)) {
    ({ health, launchAgentRecovery } = await params.recoverHealth(health, readHealth));
    assertCurrent();
  }
  if (
    !health.healthy &&
    (!waitForStartup ||
      (health.waitOutcome !== undefined && health.waitOutcome !== "healthy") ||
      health.versionMismatch ||
      health.buildIdMismatch ||
      health.activatedPluginErrors?.length ||
      health.channelProbeErrors?.length ||
      health.staleGatewayPids.length > 0)
  ) {
    return { health, readyz: false, http: undefined, launchAgentRecovery };
  }
  params.onProgress?.("http", "checking Gateway HTTP healthz and readyz endpoints");
  const context = await resolveGatewayRestartProbeContext(params.serviceEnv);
  assertCurrent();
  const http = await waitForGatewayHttpReadiness({
    config: context.config,
    port: params.gatewayPort,
    attempts: waitForStartup ? Math.ceil(remainingMs() / DEFAULT_RESTART_HEALTH_DELAY_MS) : 1,
    deadlineAt: Date.now() + remainingMs(),
    probeTimeoutMs: probeTimeoutMs(),
    delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
    onObservation: (observation) =>
      params.onProgress?.(
        "http",
        `HTTP healthz=${observation.healthz ?? "unavailable"}; readyz=${observation.readyz ?? "unavailable"}`,
      ),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  assertCurrent();
  const readyz = http.readyz === 200;
  if (health.healthy && (!params.requireRunningService || health.runtime.status === "running")) {
    // HTTP readiness cannot transfer an earlier settle to a replacement boot.
    const settled = health;
    const inspect = () =>
      inspectGatewayRestart({
        ...probeParams,
        probeContext: context,
        timeoutMs: Math.max(1, probeTimeoutMs()),
      });
    const inspected = await inspect();
    assertCurrent();
    // Bracket the final native observation with health/hello probes so a same-PID
    // or PID-less reboot during that observation cannot inherit the old boot.
    health = inspected.healthy ? await inspect() : inspected;
    assertCurrent();
    health.startupPhase = settled.startupPhase;
    const sameGeneration =
      isSameGatewayRestartGeneration(settled, inspected) &&
      isSameGatewayRestartGeneration(inspected, health);
    if (!sameGeneration) {
      health.healthy = false;
      health.waitOutcome = "generation-changed";
      health.probeError = "Gateway process changed during final readiness verification.";
    }
  }
  if (health.waitOutcome !== "generation-changed" && (!readyz || remainingMs() === 0)) {
    health = {
      ...health,
      healthy: false,
      ...(waitForStartup
        ? {
            waitOutcome: "timeout" as const,
            elapsedMs: performance.now() - startedAtMs,
            ...(!readyz ? { startupPhase: "waiting for Gateway HTTP readiness" } : {}),
          }
        : {}),
    };
  }
  return { health, readyz, http, launchAgentRecovery };
}

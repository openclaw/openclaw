// Restart health probes for gateway service restarts and port listener recovery.
import type { ChildProcess } from "node:child_process";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayServiceProbeHosts } from "../../daemon/gateway-service-probe-hosts.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import type { PluginHealthErrorSummary } from "../../gateway/health/types.js";
import {
  createConfiguredGatewayLocalProbe,
  type ConfiguredGatewayLocalProbe,
} from "../../gateway/local-http-probe.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import { classifyPortListener } from "../../infra/ports-format.js";
import { inspectPortUsage } from "../../infra/ports-inspect.js";
import type { PortUsage } from "../../infra/ports-types.js";
import {
  hasActiveStartupMigrationLease,
  STARTUP_MIGRATION_HEARTBEAT_INTERVAL_MS,
  STARTUP_MIGRATION_LEASE_TTL_MS,
} from "../../infra/startup-migration-checkpoint.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import type { OpenClawStateSchemaReadAdmission } from "../../state/openclaw-state-db-contract.js";
import { sleep } from "../../utils.js";
import {
  confirmGatewayReachable,
  readGatewayStartupPhase,
  resolveGatewayRestartProbeContext,
  type GatewayReachability,
  type GatewayRestartProbeContext,
} from "./restart-health-probe.js";
import { finalizeGatewayRestartSnapshot } from "./restart-health-snapshot.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
} from "./restart-health.constants.js";
import type { GatewayRestartSnapshot, GatewayRestartWaitOutcome } from "./restart-health.types.js";
import {
  allListenersOwnedByRuntimePid,
  hasListenerAttributionGap,
  listenerOwnedByRuntimePid,
} from "./restart-port-ownership.js";
export {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
} from "./restart-health.constants.js";
export { waitForGatewayHttpReadiness } from "./restart-health-probe.js";
export {
  formatGatewayRestartFailure,
  renderGatewayPortHealthDiagnostics,
  renderRestartDiagnostics,
} from "./restart-health-diagnostics.js";
export { waitForGatewayHealthyListener } from "./restart-health-external.js";
export type { GatewayRestartSnapshot } from "./restart-health.types.js";
export { terminateStaleGatewayPids } from "../../infra/restart-stale-pids.js";

const STARTUP_MIGRATION_ACTIVITY_POLL_MS = 5_000;
const STOPPED_FREE_EARLY_EXIT_GRACE_MS = 10_000;
const WINDOWS_STOPPED_FREE_EARLY_EXIT_GRACE_MS = 90_000;

export async function inspectGatewayRestart(params: {
  service: Pick<GatewayService, "readCommand" | "readRuntime">;
  port: number;
  env?: NodeJS.ProcessEnv;
  expectedVersion?: string | null;
  expectedBuildId?: string | null;
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission;
  requirePluginHealth?: boolean;
  probeContext?: GatewayRestartProbeContext;
  configuredProbe?: ConfiguredGatewayLocalProbe;
  probeHosts?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<GatewayRestartSnapshot> {
  params.signal?.throwIfAborted();
  const startedAtMs = performance.now();
  const remainingTimeoutMs = () =>
    params.timeoutMs === undefined
      ? undefined
      : Math.max(1, params.timeoutMs - (performance.now() - startedAtMs));
  const env = params.env ?? process.env;
  const probeHosts =
    params.probeHosts ??
    (await resolveGatewayServiceProbeHosts({
      env,
      command:
        (await params.service.readCommand?.(env).catch((error: unknown) => {
          if (hasCommandProcessCleanupError(error)) {
            throw error;
          }
          return null;
        })) ?? null,
    }));
  const expectedVersion = normalizeOptionalString(params.expectedVersion);
  const expectedBuildId = normalizeOptionalString(params.expectedBuildId);
  const requiresGatewayProbe = Boolean(
    expectedVersion || expectedBuildId || params.requirePluginHealth === false,
  );
  let reachability: GatewayReachability | null = null;
  let probeError: string | undefined;
  let gatewayBootId: string | undefined;
  let gatewayVersion: string | null | undefined;
  let gatewayBuildId: string | null | undefined;
  let activatedPluginErrors: PluginHealthErrorSummary[] = [];
  let unavailablePlugins: GatewayReachability["unavailablePlugins"] = [];
  let channelProbeErrors: Array<{ id: string; error: string }> = [];
  const loadReachability = async () => {
    if (!reachability) {
      reachability = await confirmGatewayReachable({
        port: params.port,
        ...params.probeContext,
        ...(params.configuredProbe ? { configuredProbe: params.configuredProbe } : {}),
        env,
        timeoutMs: remainingTimeoutMs(),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      probeError = reachability.probeError;
      gatewayBootId = reachability.gatewayBootId;
      gatewayVersion = reachability.gatewayVersion;
      gatewayBuildId = reachability.gatewayBuildId;
      activatedPluginErrors = reachability.activatedPluginErrors;
      unavailablePlugins = reachability.unavailablePlugins;
      channelProbeErrors = reachability.channelProbeErrors;
    }
    return reachability;
  };
  let runtime: GatewayServiceRuntime;
  try {
    runtime =
      params.timeoutMs === undefined
        ? await params.service.readRuntime(env)
        : await params.service.readRuntime(env, { timeoutMs: remainingTimeoutMs() });
  } catch (err) {
    if (hasCommandProcessCleanupError(err)) {
      throw err;
    }
    runtime = { status: "unknown", detail: String(err) };
  }

  params.signal?.throwIfAborted();
  let portUsage: PortUsage;
  try {
    portUsage = await inspectPortUsage(params.port, {
      probeHosts,
    });
  } catch (err) {
    if (hasCommandProcessCleanupError(err)) {
      throw err;
    }
    portUsage = {
      port: params.port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  params.signal?.throwIfAborted();
  const startupPhase =
    portUsage.status === "busy" && params.configuredProbe
      ? await readGatewayStartupPhase({
          configuredProbe: params.configuredProbe,
          port: params.port,
          timeoutMs: remainingTimeoutMs(),
          ...(params.signal ? { signal: params.signal } : {}),
        })
      : undefined;
  if (startupPhase && (expectedVersion || expectedBuildId)) {
    // Startup cannot conceal a previous install or a definitive plugin/channel failure.
    await loadReachability();
  }
  if (!startupPhase && portUsage.status === "busy" && runtime.status !== "running") {
    const reachable = await loadReachability();
    if (reachable.reachable) {
      return finalizeGatewayRestartSnapshot(
        {
          runtime,
          portUsage,
          healthy: true,
          staleGatewayPids: [],
          gatewayVersion: reachable.gatewayVersion,
          ...(reachable.gatewayBootId ? { gatewayBootId: reachable.gatewayBootId } : {}),
          gatewayBuildId: reachable.gatewayBuildId,
          ...(reachable.activatedPluginErrors.length > 0
            ? { activatedPluginErrors: reachable.activatedPluginErrors }
            : {}),
          ...(reachable.unavailablePlugins.length > 0
            ? { unavailablePlugins: reachable.unavailablePlugins }
            : {}),
          ...(reachable.channelProbeErrors.length > 0
            ? { channelProbeErrors: reachable.channelProbeErrors }
            : {}),
        },
        expectedVersion,
        expectedBuildId,
        params.requirePluginHealth !== false,
      );
    }
  }

  const gatewayListeners =
    portUsage.status === "busy"
      ? portUsage.listeners.filter(
          (listener) => classifyPortListener(listener, params.port) === "gateway",
        )
      : [];
  const running = runtime.status === "running";
  const runtimePid = runtime.pid;
  const listenerAttributionGap = hasListenerAttributionGap(portUsage);
  const ownsPort =
    runtimePid != null
      ? portUsage.listeners.some((listener) =>
          listenerOwnedByRuntimePid({ listener, runtimePid }),
        ) || listenerAttributionGap
      : gatewayListeners.length > 0 || listenerAttributionGap;
  let healthy = running && ownsPort && !startupPhase;
  if (requiresGatewayProbe && healthy && portUsage.status === "busy") {
    const reachable = await loadReachability();
    healthy = reachable.reachable;
  }
  if (
    !healthy &&
    !startupPhase &&
    running &&
    portUsage.status === "busy" &&
    !requiresGatewayProbe
  ) {
    const reachable = await loadReachability();
    healthy = reachable.reachable;
  }
  // Read after probes: an owner can acquire the coordinator while health is unavailable.
  const owner =
    portUsage.status === "busy"
      ? readGatewayOwnerLease({
          env,
          port: params.port,
          ...(params.openStateSchemaReadAdmission
            ? { openStateSchemaReadAdmission: params.openStateSchemaReadAdmission }
            : {}),
        })
      : undefined;
  // A recorded owner is never stale by PID inference; other listeners are foreign.
  // 2026.9.3 Gateways have no row and retain the installed-runtime ownership path.
  const staleGatewayPids = owner
    ? []
    : Array.from(
        new Set(
          gatewayListeners.flatMap((listener) =>
            typeof listener.pid === "number" &&
            Number.isFinite(listener.pid) &&
            (!running ||
              (runtimePid != null && !listenerOwnedByRuntimePid({ listener, runtimePid })))
              ? [listener.pid]
              : [],
          ),
        ),
      );

  return finalizeGatewayRestartSnapshot(
    {
      runtime,
      portUsage,
      healthy,
      staleGatewayPids,
      ...(gatewayBootId ? { gatewayBootId } : {}),
      ...(gatewayVersion !== undefined ? { gatewayVersion } : {}),
      ...(gatewayBuildId !== undefined ? { gatewayBuildId } : {}),
      ...(startupPhase ? { startupPhase } : {}),
      ...(probeError ? { probeError } : {}),
      ...(activatedPluginErrors.length ? { activatedPluginErrors } : {}),
      ...(unavailablePlugins.length ? { unavailablePlugins } : {}),
      ...(channelProbeErrors.length ? { channelProbeErrors } : {}),
    },
    expectedVersion,
    expectedBuildId,
    params.requirePluginHealth !== false,
  );
}

function shouldEarlyExitStoppedFree(
  snapshot: GatewayRestartSnapshot,
  attempt: number,
  minAttempt: number,
): boolean {
  return (
    attempt >= minAttempt &&
    snapshot.runtime.status === "stopped" &&
    snapshot.portUsage.status === "free"
  );
}

function stoppedFreeEarlyExitGraceMs(): number {
  return process.platform === "win32"
    ? WINDOWS_STOPPED_FREE_EARLY_EXIT_GRACE_MS
    : STOPPED_FREE_EARLY_EXIT_GRACE_MS;
}

function withWaitContext(
  snapshot: GatewayRestartSnapshot,
  waitOutcome: GatewayRestartWaitOutcome,
  elapsedMs: number,
): GatewayRestartSnapshot {
  return { ...snapshot, waitOutcome, elapsedMs };
}

export function isSameGatewayRestartGeneration(
  previous: GatewayRestartSnapshot,
  current: GatewayRestartSnapshot,
): boolean {
  return (
    previous.runtime.status === current.runtime.status &&
    previous.runtime.pid === current.runtime.pid &&
    previous.gatewayBootId === current.gatewayBootId
  );
}

type GatewayRestartWaitOptions = {
  port: number;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  /** Absolute performance.now() deadline supplied by a longer diagnostic operation. */
  deadlineMs?: number;
  settle?: { probes: number };
  env?: NodeJS.ProcessEnv;
  expectedVersion?: string | null;
  expectedBuildId?: string | null;
  requireRunningService?: boolean;
  requirePluginHealth?: boolean;
  supervisorKeepsAlive?: boolean;
  isStartupMigrationActive?: typeof hasActiveStartupMigrationLease;
  probeHosts?: readonly string[];
  probeContext?: GatewayRestartProbeContext;
  onProgress?: (phase: string) => void;
  signal?: AbortSignal;
};

export async function waitForGatewayHealthyRestart(
  params: GatewayRestartWaitOptions &
    (
      | { service: Pick<GatewayService, "readCommand" | "readRuntime">; child?: never }
      | { child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">; service?: never }
    ),
): Promise<GatewayRestartSnapshot> {
  params.signal?.throwIfAborted();
  const child = params.child;
  const service: Pick<GatewayService, "readCommand" | "readRuntime"> = params.service ?? {
    readCommand: async () => null,
    readRuntime: async () => ({
      status:
        child?.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null &&
        isPidAlive(child.pid)
          ? "running"
          : "stopped",
      pid: child?.pid,
    }),
  };
  const startedAtMs = performance.now();
  const remainingDeadlineMs =
    params.deadlineMs === undefined ? undefined : Math.max(0, params.deadlineMs - startedAtMs);
  const timeoutMs =
    remainingDeadlineMs === undefined
      ? params.timeoutMs
      : Math.min(params.timeoutMs ?? remainingDeadlineMs, remainingDeadlineMs);
  if (remainingDeadlineMs === 0) {
    return withWaitContext(
      {
        runtime: { status: "unknown" },
        portUsage: { port: params.port, status: "unknown", listeners: [], hints: [] },
        healthy: false,
        staleGatewayPids: [],
        probeError: "Gateway readiness budget exhausted.",
      },
      "timeout",
      0,
    );
  }
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;
  const settleProbes = Math.max(1, params.settle?.probes ?? 1);
  const settleDurationMs = Math.min(
    (settleProbes - 1) * delayMs,
    remainingDeadlineMs === undefined
      ? Infinity
      : Math.max(0, remainingDeadlineMs - (params.timeoutMs ?? remainingDeadlineMs)),
  );
  // A longer update budget must not make an old heartbeat count as fresh progress.
  const progressWindowMs = attempts * delayMs;
  const standardDeadlineMs = timeoutMs ?? progressWindowMs;
  const probeTimeoutMs = () =>
    timeoutMs === undefined
      ? undefined
      : Math.max(1, timeoutMs + settleDurationMs - (performance.now() - startedAtMs));
  const updateInProgress = (params.env ?? process.env).OPENCLAW_UPDATE_IN_PROGRESS === "1";

  const probeContext =
    params.probeContext ??
    (await resolveGatewayRestartProbeContext(params.env).catch(() => ({
      auth: undefined,
      config: {},
    })));
  const configuredProbe = createConfiguredGatewayLocalProbe(probeContext.config);
  const probeHosts =
    params.probeHosts ??
    (await resolveGatewayServiceProbeHosts({
      env: params.env,
      command: await service.readCommand(params.env ?? process.env).catch((error: unknown) => {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        return null;
      }),
    }));
  let snapshot = await inspectGatewayRestart({
    service,
    port: params.port,
    env: params.env,
    expectedVersion: params.expectedVersion,
    expectedBuildId: params.expectedBuildId,
    requirePluginHealth: params.requirePluginHealth,
    probeContext,
    configuredProbe,
    probeHosts,
    timeoutMs: probeTimeoutMs(),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  let consecutiveStoppedFreeCount = 0;
  const STOPPED_FREE_THRESHOLD = 6;
  const minAttemptForEarlyExit = Math.min(
    Math.ceil(stoppedFreeEarlyExitGraceMs() / delayMs),
    Math.floor(attempts / 2),
  );
  let migrationActive = false;
  let nextMigrationActivityPollMs = 0;
  let migrationActivity: { owner: string; pid: number; heartbeatAt: number } | undefined;
  let observedRunning = false;
  let observedListener = false;
  let startupProgressDeadlineMs = progressWindowMs;
  let healthyStreak: { snapshot: GatewayRestartSnapshot; probes: number } | undefined;
  let updateStartupDeadlineMs: number | undefined;
  let observedOwner: string | undefined;
  let observedPid: number | undefined;
  let observedBootId: string | undefined;
  let generationChanged = false;
  let reportedStartupPhase: string | undefined;
  let lastProgressPhase: string | undefined;
  const expiredOutcome = (elapsedMs: number, atStartupCap: boolean): GatewayRestartWaitOutcome => {
    if (generationChanged) {
      return "generation-changed";
    }
    if (
      snapshot.runtime.status !== "running" ||
      (snapshot.runtime.pid === undefined && snapshot.gatewayBootId === undefined) ||
      snapshot.versionMismatch ||
      snapshot.buildIdMismatch ||
      snapshot.channelProbeErrors?.length ||
      (params.requirePluginHealth !== false && snapshot.activatedPluginErrors?.length) ||
      snapshot.staleGatewayPids.length > 0
    ) {
      return "timeout";
    }
    const ownedStartup =
      reportedStartupPhase &&
      snapshot.portUsage.status === "busy" &&
      snapshot.runtime.pid !== undefined &&
      allListenersOwnedByRuntimePid(snapshot.portUsage.listeners, snapshot.runtime.pid);
    return ownedStartup ||
      (atStartupCap &&
        startupProgressDeadlineMs > progressWindowMs &&
        elapsedMs < startupProgressDeadlineMs)
      ? "still-starting"
      : "timeout";
  };

  for (let attempt = 0; ; attempt += 1) {
    params.signal?.throwIfAborted();
    // Preserve observed restarts across unavailable probes.
    generationChanged ||=
      (observedPid !== undefined &&
        snapshot.runtime.pid !== undefined &&
        observedPid !== snapshot.runtime.pid) ||
      (observedBootId !== undefined &&
        snapshot.gatewayBootId !== undefined &&
        observedBootId !== snapshot.gatewayBootId);
    const identifiedBoot = observedBootId === undefined && snapshot.gatewayBootId !== undefined;
    observedPid = snapshot.runtime.pid ?? observedPid;
    observedBootId = snapshot.gatewayBootId ?? observedBootId;
    // Health probes and state-DB reads are part of the operator-visible wait. A monotonic clock
    // keeps both the normal deadline and migration watchdog bounded when those operations stall.
    let elapsedMs = Math.max(0, performance.now() - startedAtMs);
    if (updateInProgress && snapshot.runtime.status === "running") {
      // Old updaters invoke the candidate CLI without forwarding their budget. A live
      // process earns the startup watchdog; later phases never reset its finite cap.
      updateStartupDeadlineMs ??= Math.max(standardDeadlineMs, STARTUP_MIGRATION_LEASE_TTL_MS);
    }
    const boundedDeadlineMs = timeoutMs ?? updateStartupDeadlineMs;
    // A managed settle streak needs a concrete process identity. Scheduled Tasks can
    // report running without exposing a PID, so Windows retains status-only proof.
    const healthy =
      snapshot.healthy &&
      (!params.requireRunningService ||
        (snapshot.runtime.status === "running" &&
          (process.platform === "win32" || typeof snapshot.runtime.pid === "number")));
    reportedStartupPhase = snapshot.startupPhase;
    snapshot.startupPhase =
      reportedStartupPhase ??
      (healthy
        ? "settling healthy Gateway"
        : snapshot.runtime.status !== "running"
          ? "waiting for managed service"
          : snapshot.portUsage.status === "free"
            ? "waiting for Gateway listener"
            : "waiting for Gateway health and identity");
    if (boundedDeadlineMs !== undefined && elapsedMs > boundedDeadlineMs + settleDurationMs) {
      return withWaitContext(
        { ...snapshot, healthy: false },
        expiredOutcome(elapsedMs, true),
        elapsedMs,
      );
    }
    if (healthy) {
      if (healthyStreak && isSameGatewayRestartGeneration(healthyStreak.snapshot, snapshot)) {
        healthyStreak.probes += 1;
      } else {
        healthyStreak = { snapshot, probes: 1 };
      }
      if (healthyStreak.probes >= settleProbes) {
        return withWaitContext(snapshot, "healthy", elapsedMs);
      }
    } else {
      healthyStreak = undefined;
    }
    if (settleProbes > 1 && snapshot.healthy) {
      // Callers consume snapshot.healthy; a partial settle must not report recovery at timeout.
      snapshot.healthy = false;
    }
    if (params.requirePluginHealth !== false && snapshot.activatedPluginErrors?.length) {
      return withWaitContext(snapshot, "plugin-errors", elapsedMs);
    }
    if (snapshot.channelProbeErrors?.length) {
      return withWaitContext(snapshot, "channel-errors", elapsedMs);
    }
    if (snapshot.versionMismatch) {
      return withWaitContext(snapshot, "version-mismatch", elapsedMs);
    }
    if (snapshot.buildIdMismatch) {
      return withWaitContext(snapshot, "build-id-mismatch", elapsedMs);
    }
    if (snapshot.staleGatewayPids.length > 0 && snapshot.runtime.status !== "running") {
      return withWaitContext(snapshot, "stale-pids", elapsedMs);
    }
    const stoppedFree =
      snapshot.runtime.status === "stopped" && snapshot.portUsage.status === "free";
    const owner = stoppedFree
      ? readGatewayOwnerLease({ env: params.env, port: params.port })
      : undefined;
    if (owner && owner.state !== "dead") {
      observedOwner = owner.owner;
    } else if (owner?.state === "dead" && owner.owner === observedOwner) {
      return withWaitContext(snapshot, "stopped-free", elapsedMs);
    }
    // A previous crashed owner cannot describe replacement startup. Keep native
    // startup grace for it and for published 2026.9.3 processes without owner rows.
    if (
      (!owner || owner.state === "dead") &&
      !params.supervisorKeepsAlive &&
      shouldEarlyExitStoppedFree(snapshot, attempt, minAttemptForEarlyExit)
    ) {
      consecutiveStoppedFreeCount += 1;
      if (consecutiveStoppedFreeCount >= STOPPED_FREE_THRESHOLD) {
        return withWaitContext(snapshot, "stopped-free", elapsedMs);
      }
    } else {
      consecutiveStoppedFreeCount = 0;
    }

    let migrationProgress = false;
    let migrationCompleted = false;
    if (snapshot.runtime.status !== "running") {
      migrationActive = false;
    } else if (elapsedMs >= nextMigrationActivityPollMs) {
      const previousActivity = migrationActivity;
      migrationActivity = undefined;
      try {
        migrationActive = (params.isStartupMigrationActive ?? hasActiveStartupMigrationLease)({
          env: params.env,
          onActivity: (activity) => {
            if (
              activity.pid === undefined ||
              activity.pid !== snapshot.runtime.pid ||
              activity.heartbeatAt === null
            ) {
              return;
            }
            // Acquisition earns one heartbeat window; later credit requires renewed
            // activity from the same lease, not merely a live process.
            migrationProgress =
              previousActivity === undefined ||
              (activity.owner === previousActivity.owner &&
                activity.heartbeatAt > previousActivity.heartbeatAt);
            migrationActivity = {
              owner: activity.owner,
              pid: activity.pid,
              heartbeatAt: activity.heartbeatAt,
            };
          },
        });
        // Consume an observed same-process release once. Foreign activity clears the
        // observation; a failed read cannot establish completion or a new acquisition.
        migrationCompleted =
          !migrationActive &&
          previousActivity !== undefined &&
          previousActivity.pid === snapshot.runtime.pid;
      } catch {
        migrationActive = false;
        migrationProgress = false;
        migrationActivity = previousActivity;
      }
      nextMigrationActivityPollMs = elapsedMs + STARTUP_MIGRATION_ACTIVITY_POLL_MS;
    }
    if (boundedDeadlineMs === undefined) {
      elapsedMs = Math.max(0, performance.now() - startedAtMs);
    }

    if (migrationActive && !reportedStartupPhase) {
      snapshot.startupPhase = "startup migration";
    }
    if (
      (reportedStartupPhase || snapshot.runtime.status === "running") &&
      snapshot.startupPhase !== lastProgressPhase
    ) {
      lastProgressPhase = snapshot.startupPhase;
      params.onProgress?.(snapshot.startupPhase);
    }
    const runtimePid = snapshot.runtime.pid;
    const ownsListener =
      snapshot.portUsage.status === "busy" &&
      runtimePid !== undefined &&
      snapshot.portUsage.listeners.some((listener) =>
        listenerOwnedByRuntimePid({ listener, runtimePid }),
      );
    const running = snapshot.runtime.status === "running";
    const startupProgress =
      attempt > 0 &&
      ((!observedRunning && running) || (!observedListener && ownsListener) || identifiedBoot);
    const stableRunning =
      running &&
      (snapshot.runtime.pid !== undefined || snapshot.gatewayBootId !== undefined) &&
      !generationChanged;
    if (
      !healthy &&
      stableRunning &&
      (boundedDeadlineMs !== undefined ||
        elapsedMs <= startupProgressDeadlineMs + settleDurationMs) &&
      (migrationProgress || migrationCompleted || startupProgress)
    ) {
      // Include one poll of observation lag after the producer's renewal interval.
      startupProgressDeadlineMs = Math.max(
        startupProgressDeadlineMs,
        elapsedMs +
          Math.max(
            progressWindowMs,
            migrationProgress
              ? STARTUP_MIGRATION_HEARTBEAT_INTERVAL_MS + STARTUP_MIGRATION_ACTIVITY_POLL_MS
              : 0,
          ),
      );
    }
    // Re-observing a service or listener after a failed probe is not new progress.
    observedRunning ||= running;
    observedListener ||= ownsListener;
    if (elapsedMs >= standardDeadlineMs) {
      const startupCapMs = Math.max(standardDeadlineMs, STARTUP_MIGRATION_LEASE_TTL_MS);
      // Explicit budgets and the shipped updater marker keep their existing behavior.
      const deadlineMs =
        boundedDeadlineMs !== undefined
          ? boundedDeadlineMs + settleDurationMs
          : Math.min(
              (stableRunning ? startupProgressDeadlineMs : standardDeadlineMs) + settleDurationMs,
              startupCapMs,
            );
      if (elapsedMs >= deadlineMs) {
        return withWaitContext(
          snapshot,
          expiredOutcome(elapsedMs, boundedDeadlineMs !== undefined || elapsedMs >= startupCapMs),
          elapsedMs,
        );
      }
    }
    await sleep(
      boundedDeadlineMs === undefined
        ? delayMs
        : Math.min(delayMs, Math.max(0, boundedDeadlineMs + settleDurationMs - elapsedMs)),
      params.signal,
    );
    snapshot = await inspectGatewayRestart({
      service,
      port: params.port,
      env: params.env,
      expectedVersion: params.expectedVersion,
      expectedBuildId: params.expectedBuildId,
      requirePluginHealth: params.requirePluginHealth,
      probeContext,
      configuredProbe,
      probeHosts,
      timeoutMs: probeTimeoutMs(),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }
}

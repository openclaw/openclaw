// Gateway readiness checker for channel health and startup sidecar state.
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReadinessCondition, CanonicalReadinessResult } from "../../readiness/conditions.js";
import {
  CORE_READINESS_SUBJECT_REFS,
  normalizeRelatedSubjectRefs,
  reconcileReadinessIdentity,
  type ReadinessIdentity,
} from "../../readiness/subjects.js";
import type { AgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
  type ChannelHealthEvaluation,
} from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";
import type { GatewayPluginReloadStatus } from "../server-plugin-runtime-generation.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

/** Snapshot returned by the gateway readiness probe. */
type ReadinessResult = {
  ready: boolean;
  failing: string[];
  suppressed?: string[];
  uptimeMs: number;
  eventLoop?: GatewayEventLoopHealth;
  pluginReload?: GatewayPluginReloadStatus;
  agentDatabases?: readonly AgentDatabaseAdmissionRefusal[];
  stateDatabase?: { reason: string };
  conditions?: ReadinessCondition[];
  failures?: string[];
  advisories?: string[];
};

export type CanonicalGatewayReadinessResult = ReadinessResult & CanonicalReadinessResult;

/** Function form used by HTTP readiness endpoints and tests. */
export type ReadinessChecker = () => ReadinessResult | Promise<ReadinessResult>;

export type StartupResult =
  | { ok: true; status: "started"; uptimeMs: number }
  | { ok: false; status: "starting"; uptimeMs: number; pendingReason: string }
  | { ok: false; status: "draining"; uptimeMs: number };

/** Function form used by HTTP startup endpoints and tests. */
export type StartupChecker = () => StartupResult;

type GatewayStartupStateDeps = {
  startedAt: number;
  getStartupPending?: () => boolean;
  getStartupPendingReason?: () => string | undefined;
  getGatewayDraining?: () => boolean;
};

const DEFAULT_READINESS_CACHE_TTL_MS = 1_000;
const DEFAULT_READINESS_EVALUATION_TIMEOUT_MS = 2_000;

class ReadinessEvaluationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`readiness evaluation exceeded ${timeoutMs}ms`);
    this.name = "ReadinessEvaluationTimeoutError";
  }
}

async function withReadinessEvaluationTimeout<T>(
  evaluation: Promise<T>,
  timeoutMs = DEFAULT_READINESS_EVALUATION_TIMEOUT_MS,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      evaluation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ReadinessEvaluationTimeoutError(timeoutMs)),
          Math.max(1, timeoutMs),
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Create a startup checker that excludes downstream channel health. */
export function createStartupChecker(deps: GatewayStartupStateDeps): StartupChecker {
  return (): StartupResult => {
    const uptimeMs = Date.now() - deps.startedAt;
    if (deps.getGatewayDraining?.()) {
      return { ok: false, status: "draining", uptimeMs };
    }
    if (deps.getStartupPending?.()) {
      return {
        ok: false,
        status: "starting",
        uptimeMs,
        pendingReason: deps.getStartupPendingReason?.() ?? "startup-sidecars",
      };
    }
    return { ok: true, status: "started", uptimeMs };
  };
}

function buildReadinessEvaluationFailure(
  error: unknown,
  identity: ReadinessIdentity,
): CanonicalReadinessResult {
  const timedOut = error instanceof ReadinessEvaluationTimeoutError;
  const reason = timedOut ? "ReadinessEvaluationTimedOut" : "ReadinessEvaluationFailed";
  const condition: ReadinessCondition = {
    type: "ReadinessEvaluationComplete",
    subjectRef: identity.producerRef,
    status: "Unknown",
    requirement: "required",
    reason,
    message: timedOut
      ? "Readiness evaluation did not complete within its bounded deadline."
      : "Readiness evaluation could not be completed.",
  };
  return {
    contractVersion: 1,
    evaluatedAtMs: Date.now(),
    identity: reconcileReadinessIdentity({
      base: identity,
      // SAFETY: this condition sets subjectRef to identity.producerRef above.
      references: [condition as ReadinessCondition & { subjectRef: string }],
    }),
    ready: false,
    conditions: [condition],
    failures: [reason],
    advisories: [],
  };
}

function buildCoreCondition(params: {
  type: ReadinessCondition["type"];
  status: ReadinessCondition["status"];
  requirement?: ReadinessCondition["requirement"];
  reason: string;
  message: string;
}): ReadinessCondition {
  return {
    type: params.type,
    status: params.status,
    requirement: params.requirement ?? "required",
    reason: params.reason,
    message: params.message,
  };
}

function buildStartupCondition(pending: boolean, pendingReason?: string): ReadinessCondition {
  return buildCoreCondition({
    type: "GatewayStartupComplete",
    status: pending ? "False" : "True",
    reason: pending ? "GatewayStartupPending" : "GatewayStartupComplete",
    message: pending
      ? `Gateway startup dependencies are still pending${pendingReason ? `: ${pendingReason}` : ""}.`
      : "Gateway startup dependencies are complete.",
  });
}

function buildSuppressedChannelCondition(suppressed: string[]): ReadinessCondition | undefined {
  if (suppressed.length === 0) {
    return undefined;
  }
  return buildCoreCondition({
    type: "ChannelRuntimeSuppressed",
    status: "False",
    requirement: "advisory",
    reason: "ChannelRuntimeSuppressed",
    message: `Channel runtime failures are suppressed: ${suppressed.join(", ")}.`,
  });
}

function buildAcceptingWorkCondition(draining: boolean): ReadinessCondition {
  return buildCoreCondition({
    type: "GatewayAcceptingWork",
    status: draining ? "False" : "True",
    reason: draining ? "GatewayDraining" : "GatewayAcceptingWork",
    message: draining
      ? "Gateway is draining and is not accepting new work."
      : "Gateway is accepting new work.",
  });
}

function buildChannelCondition(params: {
  checked: boolean;
  failing: string[];
}): ReadinessCondition {
  if (!params.checked) {
    return buildCoreCondition({
      type: "ChannelRuntimeReady",
      status: "Unknown",
      reason: "ChannelRuntimeNotChecked",
      message: "Channel runtime health was not evaluated on this readiness pass.",
    });
  }
  if (params.failing.length > 0) {
    return buildCoreCondition({
      type: "ChannelRuntimeReady",
      status: "False",
      reason: "ChannelRuntimeUnavailable",
      message: `Selected channels are not ready: ${params.failing.join(", ")}.`,
    });
  }
  return buildCoreCondition({
    type: "ChannelRuntimeReady",
    status: "True",
    reason: "ChannelRuntimeReady",
    message: "Selected channel runtimes are ready.",
  });
}

function buildEventLoopCondition(
  eventLoop: GatewayEventLoopHealth | undefined,
): ReadinessCondition {
  if (!eventLoop) {
    return buildCoreCondition({
      type: "EventLoopHealthy",
      status: "Unknown",
      requirement: "advisory",
      reason: "EventLoopStatusUnavailable",
      message: "Event-loop health is not available yet.",
    });
  }
  return buildCoreCondition({
    type: "EventLoopHealthy",
    status: eventLoop.degraded ? "False" : "True",
    requirement: "advisory",
    reason: eventLoop.degraded ? "EventLoopDegraded" : "EventLoopHealthy",
    message: eventLoop.degraded
      ? `Event-loop health is degraded: ${eventLoop.reasons.join(", ")}.`
      : "Event-loop health is within its healthy thresholds.",
  });
}

function buildStateDatabaseCondition(): ReadinessCondition {
  return buildCoreCondition({
    type: "StateDatabaseReady",
    status: "False",
    reason: "StateDatabaseUnavailable",
    message: "The Gateway state database is unavailable.",
  });
}

function buildAgentDatabasesCondition(): ReadinessCondition {
  return buildCoreCondition({
    type: "AgentDatabasesReady",
    status: "False",
    reason: "AgentDatabaseAdmissionRefused",
    message: "One or more agent databases did not pass admission.",
  });
}

function buildPluginReloadCondition(pluginReload: GatewayPluginReloadStatus): ReadinessCondition {
  const failed = pluginReload.phase === "failed";
  return buildCoreCondition({
    type: "PluginReloadComplete",
    status: "False",
    reason: failed ? "PluginReloadFailed" : "PluginReloadInProgress",
    message: failed
      ? "Gateway plugin runtime replacement did not complete successfully."
      : "Gateway plugin runtime replacement is still in progress.",
  });
}

function shouldIgnoreReadinessFailure(
  accountSnapshot: ChannelAccountSnapshot,
  health: ChannelHealthEvaluation,
): boolean {
  if (health.reason === "unmanaged" || health.reason === "stale-socket") {
    return true;
  }
  // Channel restarts spend time in backoff with running=false before the next
  // lifecycle re-enters startup grace. Keep readiness green during that handoff
  // window, but still surface hard failures once restart attempts are exhausted.
  // A failed ingress start lands in the same backoff window, so it gets the same
  // grace: the next start re-proves ingress, and once the ladder stops setting
  // restartPending the account stays red instead of hiding dead inbound.
  const restartableReason =
    health.reason === "not-running" || health.reason === "ingress-unavailable";
  const inRestartHandoff =
    accountSnapshot.restartPending === true && accountSnapshot.running !== true;
  return restartableReason && inRestartHandoff;
}

/** Create a cached readiness checker over channel runtime health. */
export function createReadinessChecker(
  deps: GatewayStartupStateDeps & {
    channelManager: Pick<
      ChannelManager,
      "getRuntimeSnapshot" | "getAutostartSuppression" | "isAmbientAutostartSuppressed"
    >;
    getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
    getStateDatabaseFailure?: () => Error | undefined;
    getAgentDatabaseAdmissionRefusals?: () => readonly AgentDatabaseAdmissionRefusal[];
    getPluginReloadStatus?: () => GatewayPluginReloadStatus | undefined;
    shouldSkipChannelReadiness?: () => boolean;
    cacheTtlMs?: number;
  },
): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const getStartup = createStartupChecker(deps);
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedState: Omit<ReadinessResult, "uptimeMs"> | null = null;

  const readReadiness = (): ReadinessResult => {
    const startup = getStartup();
    const uptimeMs = startup.uptimeMs;
    const now = startedAt + uptimeMs;
    const startupPending = startup.status === "starting";
    const gatewayDraining = startup.status === "draining";
    const lifecycleConditions = [
      buildStartupCondition(startupPending, startupPending ? startup.pendingReason : undefined),
      buildAcceptingWorkCondition(gatewayDraining),
    ];
    if (startup.status === "starting") {
      return {
        ready: false,
        failing: [startup.pendingReason],
        uptimeMs,
        conditions: [
          ...lifecycleConditions,
          buildChannelCondition({ checked: false, failing: [] }),
        ],
      };
    }
    if (startup.status === "draining") {
      return {
        ready: false,
        failing: ["gateway-draining"],
        uptimeMs,
        conditions: [
          ...lifecycleConditions,
          buildChannelCondition({ checked: false, failing: [] }),
        ],
      };
    }
    const stateDatabaseFailure = deps.getStateDatabaseFailure?.();
    if (stateDatabaseFailure) {
      cachedState = null;
      return {
        ready: false,
        failing: ["state-database"],
        stateDatabase: { reason: stateDatabaseFailure.message },
        uptimeMs,
        conditions: [
          ...lifecycleConditions,
          buildStateDatabaseCondition(),
          buildChannelCondition({ checked: false, failing: [] }),
        ],
      };
    }
    const agentDatabases = deps.getAgentDatabaseAdmissionRefusals?.();
    if (agentDatabases?.length) {
      cachedState = null;
      return {
        ready: false,
        failing: agentDatabases.map(({ agentId }) => `agent-database:${agentId}`),
        agentDatabases,
        uptimeMs,
        conditions: [
          ...lifecycleConditions,
          buildAgentDatabasesCondition(),
          buildChannelCondition({ checked: false, failing: [] }),
        ],
      };
    }
    const pluginReload = deps.getPluginReloadStatus?.();
    if (pluginReload) {
      cachedState = null;
      return {
        ready: false,
        failing: ["plugin-reload"],
        pluginReload,
        uptimeMs,
        conditions: [
          ...lifecycleConditions,
          buildPluginReloadCondition(pluginReload),
          buildChannelCondition({ checked: false, failing: [] }),
        ],
      };
    }
    if (
      cachedState &&
      !isFutureDateTimestampMs(cachedAt, { nowMs: now }) &&
      now - cachedAt < cacheTtlMs
    ) {
      return { ...cachedState, uptimeMs };
    }
    if (deps.shouldSkipChannelReadiness?.()) {
      return {
        ready: true,
        failing: [],
        uptimeMs,
        conditions: [...lifecycleConditions, buildChannelCondition({ checked: true, failing: [] })],
      };
    }

    const snapshot = channelManager.getRuntimeSnapshot();
    const globallyAutostartSuppressed = channelManager.getAutostartSuppression() !== null;
    const failing: string[] = [];
    const suppressed: string[] = [];

    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      if (!accounts) {
        continue;
      }
      const autostartSuppressed =
        globallyAutostartSuppressed || channelManager.isAmbientAutostartSuppressed(channelId);
      for (const accountSnapshot of Object.values(accounts)) {
        if (!accountSnapshot) {
          continue;
        }
        const policy: ChannelHealthPolicy = {
          now,
          staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
          channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          channelId,
        };
        const health = evaluateChannelHealth(accountSnapshot, policy);
        if (!health.healthy && autostartSuppressed && health.reason === "not-running") {
          if (!suppressed.includes(channelId)) {
            suppressed.push(channelId);
          }
          continue;
        }
        if (!health.healthy && !shouldIgnoreReadinessFailure(accountSnapshot, health)) {
          failing.push(channelId);
          break;
        }
      }
    }

    cachedAt = now;
    const suppressedCondition = buildSuppressedChannelCondition(suppressed);
    cachedState = {
      ready: failing.length === 0,
      failing,
      ...(suppressed.length > 0 ? { suppressed } : {}),
      conditions: [
        ...lifecycleConditions,
        buildChannelCondition({ checked: true, failing }),
        ...(suppressedCondition ? [suppressedCondition] : []),
      ],
    };
    return { ...cachedState, uptimeMs };
  };
  return () => withEventLoopHealth(readReadiness(), deps.getEventLoopHealth);
}

function withEventLoopHealth(
  result: ReadinessResult,
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined,
): ReadinessResult {
  const eventLoop = getEventLoopHealth?.();
  return {
    ...result,
    ...(eventLoop ? { eventLoop } : {}),
    conditions: [
      ...(result.conditions ?? []).filter((condition) => condition.type !== "EventLoopHealthy"),
      buildEventLoopCondition(eventLoop),
    ],
  };
}

function mergeReadinessResults(
  gateway: ReadinessResult,
  runtime: CanonicalReadinessResult,
  identity: ReadinessIdentity,
  options?: { runtimeConditionsFirst?: boolean },
): CanonicalGatewayReadinessResult {
  const gatewayConditions: ReadinessCondition[] = [];
  for (const condition of gateway.conditions ?? []) {
    gatewayConditions.push({
      ...condition,
      subjectRef: condition.subjectRef ?? CORE_READINESS_SUBJECT_REFS.gateway,
    });
  }
  const conditions = options?.runtimeConditionsFirst
    ? [...runtime.conditions, ...gatewayConditions]
    : [...gatewayConditions, ...runtime.conditions];
  const conditionKeys = new Set<string>();
  for (const condition of conditions) {
    const relatedSubjectRefs = normalizeRelatedSubjectRefs(condition.relatedSubjectRefs);
    if (relatedSubjectRefs) {
      condition.relatedSubjectRefs = relatedSubjectRefs;
    }
    if (!condition.subjectRef) {
      throw new Error("canonical readiness condition is missing a subject reference");
    }
    const key = `${condition.subjectRef}\u0000${condition.type}`;
    if (conditionKeys.has(key)) {
      throw new Error("duplicate canonical readiness condition");
    }
    conditionKeys.add(key);
  }
  const failures = Array.from(
    new Set(
      conditions
        .filter((condition) => condition.requirement === "required" && condition.status !== "True")
        .map((condition) => condition.reason),
    ),
  );
  const advisories = Array.from(
    new Set(
      conditions
        .filter((condition) => condition.requirement === "advisory" && condition.status !== "True")
        .map((condition) => condition.reason),
    ),
  );
  return {
    ...gateway,
    contractVersion: 1,
    evaluatedAtMs: runtime.evaluatedAtMs,
    identity: reconcileReadinessIdentity({
      base: identity,
      subjects: runtime.identity.subjects,
      // SAFETY: the loop above rejects every condition without a subjectRef.
      references: conditions as Array<ReadinessCondition & { subjectRef: string }>,
    }),
    ready: failures.length === 0,
    failing: Array.from(new Set([...gateway.failing, ...runtime.failures])),
    conditions,
    failures,
    advisories,
  };
}

function projectLegacyGatewayReadiness(
  gateway: ReadinessResult,
  identity: ReadinessIdentity,
): CanonicalGatewayReadinessResult {
  const conditions: ReadinessCondition[] = [];
  for (const condition of gateway.conditions ?? []) {
    conditions.push({
      ...condition,
      subjectRef: condition.subjectRef ?? CORE_READINESS_SUBJECT_REFS.gateway,
    });
  }
  return {
    ...gateway,
    contractVersion: 1,
    evaluatedAtMs: Date.now(),
    identity: reconcileReadinessIdentity({
      base: identity,
      // SAFETY: every projected condition receives the gateway fallback subjectRef above.
      references: conditions as Array<ReadinessCondition & { subjectRef: string }>,
    }),
    conditions,
    failures: Array.from(
      new Set(
        conditions
          .filter(
            (condition) => condition.requirement === "required" && condition.status !== "True",
          )
          .map((condition) => condition.reason),
      ),
    ),
    advisories: Array.from(
      new Set(
        conditions
          .filter(
            (condition) => condition.requirement === "advisory" && condition.status !== "True",
          )
          .map((condition) => condition.reason),
      ),
    ),
  };
}

export async function evaluateConfiguredGatewayReadiness(params: {
  config: OpenClawConfig;
  identity: ReadinessIdentity;
  evaluateGateway: ReadinessChecker;
  evaluateRuntime: () => Promise<CanonicalReadinessResult>;
  timeoutMs?: number;
}): Promise<CanonicalGatewayReadinessResult> {
  if (params.config.gateway?.readiness === undefined) {
    try {
      return projectLegacyGatewayReadiness(await params.evaluateGateway(), params.identity);
    } catch (error) {
      return mergeReadinessResults(
        { ready: false, failing: [], uptimeMs: 0 },
        buildReadinessEvaluationFailure(error, params.identity),
        params.identity,
        { runtimeConditionsFirst: true },
      );
    }
  }
  return evaluateCanonicalGatewayReadiness({
    ...params,
    identity: params.identity,
  });
}

async function evaluateCanonicalGatewayReadiness(params: {
  identity: ReadinessIdentity;
  evaluateGateway: ReadinessChecker;
  evaluateRuntime: () => Promise<CanonicalReadinessResult>;
  timeoutMs?: number;
}): Promise<CanonicalGatewayReadinessResult> {
  let gateway: ReadinessResult | undefined;
  let gatewayRefreshStarted = false;
  const timeoutMs = params.timeoutMs ?? DEFAULT_READINESS_EVALUATION_TIMEOUT_MS;
  const deadlineMs = Date.now() + Math.max(1, timeoutMs);
  try {
    return await withReadinessEvaluationTimeout(
      Promise.resolve().then(async () => {
        gateway = await params.evaluateGateway();
        const runtime = await params.evaluateRuntime();
        // Runtime providers can outlive an admission transition; compose only current Gateway facts.
        gatewayRefreshStarted = true;
        gateway = await params.evaluateGateway();
        return mergeReadinessResults(gateway, runtime, params.identity);
      }),
      timeoutMs,
    );
  } catch (error) {
    if (gateway !== undefined && !gatewayRefreshStarted) {
      try {
        const refreshed = params.evaluateGateway();
        if (isPromiseLike(refreshed)) {
          const remainingMs = deadlineMs - Date.now();
          if (remainingMs > 0) {
            gateway = await withReadinessEvaluationTimeout(Promise.resolve(refreshed), remainingMs);
          } else {
            void Promise.resolve(refreshed).catch(() => {});
          }
        } else {
          gateway = refreshed;
        }
      } catch {
        // The retained snapshot plus the evaluation failure below remains fail-closed.
      }
    }
    return mergeReadinessResults(
      gateway ?? { ready: false, failing: [], uptimeMs: 0 },
      buildReadinessEvaluationFailure(error, params.identity),
      params.identity,
      { runtimeConditionsFirst: true },
    );
  }
}

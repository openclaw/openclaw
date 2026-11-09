// Gateway quota-resume service.
// Wakes sessions whose last run was suspended by a provider usage limit once the
// limit has reset, so interrupted work continues without a human re-prompt.
import {
  QUOTA_RESUME_CONTINUATION_TEXT,
  QUOTA_RESUME_INITIAL_DELAY_MS,
  QUOTA_RESUME_SCAN_INTERVAL_MS,
  resolveQuotaResumeDecision,
  resolveQuotaResumeRetryDelayMs,
  resolveQuotaResumeSettings,
  type QuotaResumeDecision,
} from "../agents/quota-resume-policy.js";
import type { QuotaSuspension, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatSystemTurnPrompt } from "../sessions/system-turn-prompt.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

const log = createSubsystemLogger("gateway/quota-resume");

export const QUOTA_RESUME_SOURCE_TOOL = "quota_resume" as const;
const QUOTA_RESUME_DISPATCH_TIMEOUT_MS = 30_000;
const SCAN_JOB_ID = "quota-resume:scan";
const WAKE_JOB_ID = "quota-resume:wake";

export type QuotaResumeSessionCandidate = {
  sessionKey: string;
  entry: SessionEntry;
};

export type QuotaResumeRoute = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
};

export type QuotaResumeLaunchParams = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  message: string;
  idempotencyKey: string;
  route?: QuotaResumeRoute;
};

export type QuotaResumeRuntimeDeps = {
  listAgentIds: (cfg: OpenClawConfig) => string[];
  resolveStorePath: (cfg: OpenClawConfig, agentId: string) => string;
  listSessions: (params: { agentId: string; storePath: string }) => QuotaResumeSessionCandidate[];
  isRunActive: (sessionId: string) => boolean;
  resolveProviderCooldownUntil: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    provider: string;
    model: string;
    now: number;
  }) => number | null;
  /** Transition suspended → resuming; returns false when the entry changed underneath. */
  markResuming: (params: {
    agentId: string;
    storePath: string;
    sessionKey: string;
    expected: QuotaSuspension;
    attempt: number;
    now: number;
  }) => Promise<boolean>;
  /** Record a lost launch so the next attempt waits instead of spinning. */
  recordLaunchFailure: (params: {
    agentId: string;
    storePath: string;
    sessionKey: string;
    attempt: number;
    now: number;
    error: string;
  }) => Promise<void>;
  recordLaunchRunId: (params: {
    agentId: string;
    storePath: string;
    sessionKey: string;
    attempt: number;
    runId: string;
  }) => Promise<void>;
  resolveRoute: (
    cfg: OpenClawConfig,
    entry: SessionEntry,
  ) => Promise<QuotaResumeRoute | undefined> | QuotaResumeRoute | undefined;
  launch: (params: QuotaResumeLaunchParams) => Promise<{ runId?: string }>;
};

export type QuotaResumeRuntime = {
  /** Run one scan immediately; used by tests and by operator-triggered wakes. */
  scanNow: () => Promise<void>;
  stop: () => Promise<void>;
};

const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);
const ENABLED_VALUES = new Set(["1", "true", "on", "yes"]);

/**
 * `agents.defaults.quotaResume.enabled` (default true) decides whether the service
 * starts; OPENCLAW_QUOTA_AUTO_RESUME overrides the config when set to a recognized value.
 */
export function isQuotaAutoResumeEnabled(
  cfg: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OPENCLAW_QUOTA_AUTO_RESUME?.trim().toLowerCase();
  if (raw && DISABLED_VALUES.has(raw)) {
    return false;
  }
  if (raw && ENABLED_VALUES.has(raw)) {
    return true;
  }
  return resolveQuotaResumeSettings(cfg).enabled;
}

export function buildQuotaResumeIdempotencyKey(params: {
  sessionId: string;
  suspendedAt: number;
  attempt: number;
}): string {
  return `quota-resume:${params.sessionId}:${params.suspendedAt}:${params.attempt}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createDefaultDeps(
  resolveGatewayContext?: GatewayContextResolver,
): Promise<QuotaResumeRuntimeDeps> {
  const [
    { listAgentIds },
    { resolveSessionStorePathCore },
    { listSessionEntriesReadOnly, patchSessionEntryCore },
    { isSessionRunActive },
    { ensureAuthProfileStore },
    { listProfilesForProvider },
    { getSoonestCooldownExpiry },
    { resolveAgentDir },
    { getGatewayLifecycleRuntime },
    { deliveryContextFromSession },
    { resolveGatewayLifecycleNoticeRoute },
  ] = await Promise.all([
    import("../agents/agent-roster.js"),
    import("../config/sessions/paths.js"),
    import("../config/sessions/session-accessor.js"),
    import("../sessions/session-controller.queries.js"),
    import("../agents/auth-profiles/store-runtime.js"),
    import("../agents/auth-profiles/profile-list.js"),
    import("../agents/auth-profiles/usage-state.js"),
    import("../agents/agent-scope-config.js"),
    import("./server-lifecycle-runtime-context.js"),
    import("../utils/delivery-context.read.js"),
    import("./server-restart-sentinel-notice.js"),
  ]);
  const patchSuspension = async (
    params: { agentId: string; storePath: string; sessionKey: string },
    update: (suspension: QuotaSuspension, entry: SessionEntry) => QuotaSuspension | null,
  ): Promise<boolean> => {
    const patched = await patchSessionEntryCore(
      params,
      (entry) => {
        const suspension = entry.quotaSuspension;
        if (!suspension) {
          return null;
        }
        const next = update(suspension, entry);
        return next ? { quotaSuspension: next } : null;
      },
      { skipMaintenance: true, takeCacheOwnership: true },
    );
    return patched !== null;
  };
  return {
    listAgentIds: (cfg) => listAgentIds(cfg),
    resolveStorePath: (cfg, agentId) =>
      resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    listSessions: ({ agentId, storePath }) =>
      listSessionEntriesReadOnly({
        agentId,
        storePath,
        projection: "list",
        clone: false,
        hydrateSkillPromptRefs: false,
      })
        .filter(({ entry }) => Boolean(entry.quotaSuspension))
        .map(({ sessionKey, entry }) => ({ sessionKey, entry: structuredClone(entry) })),
    isRunActive: (sessionId) => isSessionRunActive(sessionId),
    resolveProviderCooldownUntil: ({ cfg, agentId, provider, model, now }) => {
      try {
        const store = ensureAuthProfileStore(resolveAgentDir(cfg, agentId), {
          config: cfg,
          readOnly: true,
        });
        const profileIds = listProfilesForProvider(store, provider);
        if (profileIds.length === 0) {
          return null;
        }
        return getSoonestCooldownExpiry(store, profileIds, { now, forModel: model });
      } catch (error) {
        log.debug("quota resume: auth profile cooldown lookup failed", {
          agentId,
          provider,
          error: describeError(error),
        });
        return null;
      }
    },
    markResuming: async ({ agentId, storePath, sessionKey, expected, attempt, now }) =>
      patchSuspension({ agentId, storePath, sessionKey }, (suspension) => {
        if (
          suspension.suspendedAt !== expected.suspendedAt ||
          suspension.failedProvider !== expected.failedProvider ||
          suspension.failedModel !== expected.failedModel ||
          (suspension.state !== "suspended" && suspension.state !== "resuming")
        ) {
          return null;
        }
        return {
          ...suspension,
          state: "resuming",
          autoResume: {
            ...suspension.autoResume,
            attempts: attempt,
            lastAttemptAt: now,
            nextAttemptAt: now + resolveQuotaResumeRetryDelayMs(attempt),
          },
        };
      }),
    recordLaunchFailure: async ({ agentId, storePath, sessionKey, attempt, now, error }) => {
      await patchSuspension({ agentId, storePath, sessionKey }, (suspension) => {
        if (suspension.autoResume?.attempts !== attempt || suspension.state !== "resuming") {
          return null;
        }
        return {
          ...suspension,
          // The launch never reached the run; let the next scan retry after backoff.
          state: "suspended",
          autoResume: {
            ...suspension.autoResume,
            attempts: attempt,
            lastAttemptAt: now,
            nextAttemptAt: now + resolveQuotaResumeRetryDelayMs(attempt),
          },
          summary: suspension.summary,
        };
      });
      log.warn("quota resume: continuation launch failed", { sessionKey, attempt, error });
    },
    recordLaunchRunId: async ({ agentId, storePath, sessionKey, attempt, runId }) => {
      await patchSuspension({ agentId, storePath, sessionKey }, (suspension) => {
        if (suspension.autoResume?.attempts !== attempt) {
          return null;
        }
        return {
          ...suspension,
          autoResume: { ...suspension.autoResume, attempts: attempt, lastRunId: runId },
        };
      });
    },
    resolveRoute: async (cfg, entry) => {
      const route = await resolveGatewayLifecycleNoticeRoute({
        cfg,
        deliveryContext: deliveryContextFromSession(entry),
      });
      if (!route) {
        return undefined;
      }
      return {
        channel: route.channel,
        to: route.to,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        ...(route.threadId ? { threadId: route.threadId } : {}),
      };
    },
    launch: async (params) => {
      let runId: string | undefined;
      // Retained owner bindings must never fall through to a replacement Gateway.
      const runtime = resolveGatewayContext
        ? resolveGatewayContext()?.lifecycleRuntime
        : getGatewayLifecycleRuntime();
      if (!runtime) {
        throw new Error("Gateway lifecycle runtime unavailable for quota resume");
      }
      await runtime.dispatchAgent(
        {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          expectedExistingSessionId: params.sessionId,
          expectedExistingSessionLifecycleRevision: params.lifecycleRevision,
          message: params.message,
          deliver: Boolean(params.route),
          bestEffortDeliver: true,
          ...(params.route
            ? {
                channel: params.route.channel,
                to: params.route.to,
                ...(params.route.accountId ? { accountId: params.route.accountId } : {}),
                ...(params.route.threadId ? { threadId: params.route.threadId } : {}),
              }
            : {}),
          inputProvenance: {
            kind: "internal_system",
            sourceSessionKey: params.sessionKey,
            sourceTool: QUOTA_RESUME_SOURCE_TOOL,
          },
          idempotencyKey: params.idempotencyKey,
        },
        QUOTA_RESUME_DISPATCH_TIMEOUT_MS,
        {
          expectFinal: false,
          forceSyntheticClient: true,
          onAccepted: (payload) => {
            const accepted = payload as { runId?: unknown } | undefined;
            if (accepted && typeof accepted.runId === "string") {
              runId = accepted.runId;
            }
          },
        },
      );
      return runId ? { runId } : {};
    },
  };
}

export type StartQuotaResumeRuntimeParams = {
  scheduler: GatewayScheduler;
  readConfig: () => OpenClawConfig;
  log?: { info: (message: string) => void; warn: (message: string) => void };
  resolveGatewayContext?: GatewayContextResolver;
  /** Test seam; production resolves the default dependency set lazily. */
  deps?: Partial<QuotaResumeRuntimeDeps>;
  initialDelayMs?: number;
  scanIntervalMs?: number;
};

/** Starts the periodic scan; returns handles to force a scan or stop the service. */
export function startQuotaResumeRuntime(params: StartQuotaResumeRuntimeParams): QuotaResumeRuntime {
  const scheduler = params.scheduler.scope();
  const { signal } = scheduler;
  const serviceLog = params.log;
  let depsPromise: Promise<QuotaResumeRuntimeDeps> | undefined;
  let scanInFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const resolveDeps = () => {
    depsPromise ??= (async () => {
      const overrides = params.deps ?? {};
      const needsDefaults = (
        [
          "listAgentIds",
          "resolveStorePath",
          "listSessions",
          "isRunActive",
          "resolveProviderCooldownUntil",
          "markResuming",
          "recordLaunchFailure",
          "recordLaunchRunId",
          "resolveRoute",
          "launch",
        ] as const
      ).some((key) => overrides[key] === undefined);
      const defaults = needsDefaults ? await createDefaultDeps(params.resolveGatewayContext) : {};
      return { ...defaults, ...overrides } as QuotaResumeRuntimeDeps;
    })();
    return depsPromise;
  };

  const scheduleWake = (atMs: number) => {
    if (signal.aborted) {
      return;
    }
    const delayMs = Math.max(0, atMs - scheduler.now());
    scheduler.schedule({
      id: WAKE_JOB_ID,
      delayMs,
      mode: "earliest",
      run: () => scanNow(),
    });
  };

  const processCandidate = async (
    deps: QuotaResumeRuntimeDeps,
    cfg: OpenClawConfig,
    agentId: string,
    storePath: string,
    candidate: QuotaResumeSessionCandidate,
    now: number,
  ): Promise<QuotaResumeDecision> => {
    const { sessionKey, entry } = candidate;
    const suspension = entry.quotaSuspension;
    if (!suspension) {
      return { action: "skip", reason: "not_suspended" };
    }
    const providerCooldownUntilMs =
      suspension.reason === "quota_exhausted"
        ? deps.resolveProviderCooldownUntil({
            cfg,
            agentId,
            provider: suspension.failedProvider,
            model: suspension.failedModel,
            now,
          })
        : null;
    const decision = resolveQuotaResumeDecision({
      entry,
      now,
      runActive: deps.isRunActive(entry.sessionId),
      providerCooldownUntilMs,
      maxAttempts: resolveQuotaResumeSettings(cfg).maxAttempts,
    });
    if (decision.action !== "launch") {
      return decision;
    }
    const marked = await deps.markResuming({
      agentId,
      storePath,
      sessionKey,
      expected: suspension,
      attempt: decision.attempt,
      now,
    });
    if (!marked) {
      return { action: "skip", reason: "superseded" };
    }
    const idempotencyKey = buildQuotaResumeIdempotencyKey({
      sessionId: entry.sessionId,
      suspendedAt: suspension.suspendedAt,
      attempt: decision.attempt,
    });
    const route = await deps.resolveRoute(cfg, entry);
    serviceLog?.info(
      `quota resume: continuing ${sessionKey} after ${suspension.failedProvider}/${suspension.failedModel} limit (attempt ${decision.attempt})`,
    );
    try {
      const result = await deps.launch({
        agentId,
        sessionKey,
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision ?? null,
        message: formatSystemTurnPrompt(QUOTA_RESUME_CONTINUATION_TEXT),
        idempotencyKey,
        ...(route ? { route } : {}),
      });
      if (result.runId) {
        await deps.recordLaunchRunId({
          agentId,
          storePath,
          sessionKey,
          attempt: decision.attempt,
          runId: result.runId,
        });
      }
    } catch (error) {
      const message = describeError(error);
      serviceLog?.warn(`quota resume: launch failed for ${sessionKey}: ${message}`);
      await deps.recordLaunchFailure({
        agentId,
        storePath,
        sessionKey,
        attempt: decision.attempt,
        now,
        error: message,
      });
    }
    return decision;
  };

  const runScan = async (): Promise<void> => {
    if (signal.aborted) {
      return;
    }
    const deps = await resolveDeps();
    if (signal.aborted) {
      return;
    }
    const cfg = params.readConfig();
    const now = scheduler.now();
    let earliestWakeAtMs: number | undefined;
    for (const agentId of deps.listAgentIds(cfg)) {
      if (signal.aborted) {
        return;
      }
      let storePath: string;
      let candidates: QuotaResumeSessionCandidate[];
      try {
        storePath = deps.resolveStorePath(cfg, agentId);
        candidates = deps.listSessions({ agentId, storePath });
      } catch (error) {
        log.warn("quota resume: session scan failed", { agentId, error: describeError(error) });
        continue;
      }
      for (const candidate of candidates) {
        if (signal.aborted) {
          return;
        }
        try {
          const decision = await processCandidate(deps, cfg, agentId, storePath, candidate, now);
          if (decision.action === "wait") {
            earliestWakeAtMs =
              earliestWakeAtMs === undefined
                ? decision.resumeAtMs
                : Math.min(earliestWakeAtMs, decision.resumeAtMs);
          }
        } catch (error) {
          log.warn("quota resume: candidate evaluation failed", {
            sessionKey: candidate.sessionKey,
            error: describeError(error),
          });
        }
      }
    }
    if (earliestWakeAtMs !== undefined) {
      scheduleWake(earliestWakeAtMs);
    }
  };

  const scanNow = (): Promise<void> => {
    // Scans share state only through the store; serialize them so one wake
    // cannot launch a session another scan is already marking.
    const run = (scanInFlight ?? Promise.resolve())
      .catch(() => undefined)
      .then(runScan)
      .catch((error: unknown) => {
        if (!signal.aborted) {
          log.warn("quota resume: scan failed", { error: describeError(error) });
        }
      });
    scanInFlight = run;
    return run;
  };

  scheduler.schedule({
    id: SCAN_JOB_ID,
    delayMs: params.initialDelayMs ?? QUOTA_RESUME_INITIAL_DELAY_MS,
    everyMs: params.scanIntervalMs ?? QUOTA_RESUME_SCAN_INTERVAL_MS,
    run: () => scanNow(),
  });

  return {
    scanNow,
    stop: () => {
      stopPromise ??= Promise.all([scheduler.stop(), scanInFlight ?? Promise.resolve()]).then(
        () => {},
      );
      return stopPromise;
    },
  };
}

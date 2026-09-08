/**
 * Context-pressure awareness for the continuation system.
 *
 * Monitors session token usage relative to the context window and fires
 * system events when pressure bands are crossed. This gives the agent
 * advance warning to evacuate working state before compaction.
 *
 * Post-compaction: fires regardless of context level to inform the session
 * that compaction occurred. The session learns this cycle behaviorally.
 *
 * Band dedup: equality-based. The same band doesn't fire twice consecutively,
 * but a new band (including a lower band after compaction) always fires.
 *
 * RFC: docs/design/continue-work-signal-v2.md §4.2
 */

import type { SessionEntry } from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("continuation/context-pressure");

const DEFAULT_CONTEXT_PRESSURE_THRESHOLD = 0.8;

/** Pressure-band percentage returned by {@link resolveContextPressureBand}. */
export type PressureBand = number;

/**
 * Resolve which pressure band the current ratio falls into.
 * Returns 0 if below all bands.
 */
export function resolveContextPressureBand(
  ratio: number,
  threshold: number,
  earlyWarningBand?: number,
): PressureBand {
  if (!Number.isFinite(ratio) || ratio < 0 || !Number.isFinite(threshold) || threshold <= 0) {
    return 0;
  }
  const thresholdPct = Math.round(threshold * 100);
  const earlyWarningMultiplier = earlyWarningBand ?? 0;
  const earlyWarningThreshold =
    Number.isFinite(earlyWarningMultiplier) && earlyWarningMultiplier > 0
      ? threshold * earlyWarningMultiplier
      : 0;
  const pressureBands = [
    ...(earlyWarningThreshold > 0
      ? [{ threshold: earlyWarningThreshold, band: Math.round(earlyWarningThreshold * 100) }]
      : []),
    { threshold, band: thresholdPct },
    ...(threshold < 0.9 ? [{ threshold: 0.9, band: 90 }] : []),
    ...(Math.max(threshold, 0.9) < 0.95 ? [{ threshold: 0.95, band: 95 }] : []),
  ];
  let band: PressureBand = 0;
  for (const candidate of pressureBands) {
    if (ratio >= candidate.threshold) {
      band = candidate.band;
    }
  }
  return band;
}

interface CheckSessionContextPressureParams {
  sessionEntry: SessionEntry;
  sessionKey: string;
  contextPressureThreshold: number | undefined;
  contextWindowTokens: number;
  admittedToolNames?: ReadonlySet<string>;
  earlyWarningBand?: number;
  postCompaction?: boolean;
}

interface CheckContextPressureResult {
  fired: boolean;
  band: PressureBand;
}

type SessionContextPressureEvaluation = CheckContextPressureResult & {
  eventText?: string;
  logMessage?: string;
  logLevel?: "info" | "warn";
};

function buildContextPressureEvent(params: {
  percentUsed: number;
  tokensK: number;
  windowK: number;
  band: PressureBand;
  admittedToolNames?: ReadonlySet<string>;
  postCompaction?: boolean;
}): string {
  if (params.postCompaction) {
    return (
      `[system:context-pressure] Post-compaction: ${params.percentUsed}% context consumed ` +
      `(${params.tokensK}k/${params.windowK}k tokens). ` +
      `Session was compacted. Working state may need rehydration.`
    );
  }

  const hasContinueDelegate = params.admittedToolNames?.has("continue_delegate") === true;
  const hasRequestCompaction = params.admittedToolNames?.has("request_compaction") === true;
  if (!hasContinueDelegate && !hasRequestCompaction) {
    const urgency =
      params.band >= 95
        ? "COMPACTION IMMINENT — preserve critical working state outside the active context before the next turn."
        : "Preserve critical working state before upcoming compaction.";
    return (
      `[system:context-pressure] ${params.percentUsed}% of context window consumed ` +
      `(${params.tokensK}k / ${params.windowK}k tokens). ${urgency}`
    );
  }

  const urgency =
    hasContinueDelegate && hasRequestCompaction && params.band >= 95
      ? "COMPACTION IMMINENT — FIRST stage working-state survival via continue_delegate(mode='post-compaction', task='<working-state-summary>'), THEN call request_compaction(reason='<why>') volitionally; the alternative is forced compaction at absolute context exhaustion. " +
        "The post-compaction delegate is what carries state across the seam — if you call request_compaction without staging it first, working state will NOT survive. " +
        "Both are tool calls you can make right now, this turn."
      : hasContinueDelegate && hasRequestCompaction && params.band >= 90
        ? "Context window nearly full — FIRST stage working-state survival via continue_delegate(mode='post-compaction', task='...'), THEN call request_compaction(reason='...') volitionally; the alternative is forced compaction at absolute context exhaustion. " +
          "The post-compaction delegate fires after compaction completes and returns elective working-state to the new session — it is what carries state across the seam."
        : hasContinueDelegate
          ? "Consider continue_delegate(mode='post-compaction', task='...') to stage working-state survival for upcoming compaction, or write critical state to memory files."
          : "Preserve critical working state outside the active context, then call request_compaction(reason='...') before forced compaction.";

  return (
    `[system:context-pressure] ${params.percentUsed}% of context window consumed ` +
    `(${params.tokensK}k / ${params.windowK}k tokens). ${urgency}`
  );
}

function evaluateSessionContextPressure(
  params: CheckSessionContextPressureParams,
): SessionContextPressureEvaluation {
  const {
    sessionEntry,
    sessionKey,
    contextPressureThreshold,
    contextWindowTokens,
    admittedToolNames,
    earlyWarningBand,
    postCompaction = false,
  } = params;
  const threshold =
    contextPressureThreshold ?? (postCompaction ? DEFAULT_CONTEXT_PRESSURE_THRESHOLD : undefined);

  if (
    threshold == null ||
    threshold <= 0 ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0 ||
    sessionEntry.totalTokens == null ||
    !Number.isFinite(sessionEntry.totalTokens) ||
    sessionEntry.totalTokens <= 0 ||
    (!postCompaction && sessionEntry.totalTokensFresh === false)
  ) {
    return { fired: false, band: 0 };
  }

  const ratio = Math.max(0, sessionEntry.totalTokens / contextWindowTokens);
  const band = resolveContextPressureBand(ratio, threshold, earlyWarningBand);
  if (!postCompaction && band === 0 && ratio < threshold) {
    if (log.isEnabled("debug")) {
      log.debug(
        `[context-pressure:noop] reason=below-threshold ratio=${Math.round(ratio * 100)}% threshold=${Math.round(threshold * 100)}% rawRatio=${ratio.toFixed(4)} rawThreshold=${threshold.toFixed(4)} session=${sessionKey}`,
      );
    }
    return { fired: false, band: 0 };
  }

  const previous = sessionEntry.lastContextPressureBand;
  if (!postCompaction && previous !== undefined && band === previous) {
    if (log.isEnabled("debug")) {
      log.debug(
        `[context-pressure:noop] reason=band-dedup band=${band} previous=${previous} ratio=${Math.round(ratio * 100)}% session=${sessionKey}`,
      );
    }
    return { fired: false, band };
  }

  const percentUsed = Math.round(ratio * 100);
  const tokensK = Math.round(sessionEntry.totalTokens / 1000);
  const windowK = Math.round(contextWindowTokens / 1000);
  const eventText = buildContextPressureEvent({
    percentUsed,
    tokensK,
    windowK,
    band,
    admittedToolNames,
    postCompaction,
  });

  return {
    fired: true,
    band,
    eventText,
    logMessage: `[context-pressure:fire]${postCompaction ? " post-compaction" : ""} band=${band} previous=${previous ?? "none"} ratio=${percentUsed}% tokens=${tokensK}k/${windowK}k session=${sessionKey}`,
    logLevel: postCompaction ? "info" : "warn",
  };
}

function publishSessionContextPressure(
  params: Pick<CheckSessionContextPressureParams, "sessionEntry" | "sessionKey"> & {
    expectedSessionId?: string;
  },
  evaluation: SessionContextPressureEvaluation,
): CheckContextPressureResult {
  if (!evaluation.fired || !evaluation.eventText || !evaluation.logMessage) {
    return { fired: false, band: evaluation.band };
  }
  log[evaluation.logLevel ?? "warn"](evaluation.logMessage);
  enqueueSystemEvent(evaluation.eventText, {
    sessionKey: params.sessionKey,
    trusted: true,
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
  });
  params.sessionEntry.lastContextPressureBand = evaluation.band;
  return { fired: true, band: evaluation.band };
}

function checkSessionContextPressure(
  params: CheckSessionContextPressureParams,
): CheckContextPressureResult {
  return publishSessionContextPressure(params, evaluateSessionContextPressure(params));
}

/**
 * Check whether a context-pressure event should fire for the given session.
 */
export function checkContextPressure(
  params: CheckSessionContextPressureParams,
): CheckContextPressureResult {
  return checkSessionContextPressure(params);
}

/**
 * Applies the context-pressure policy against the latest durable session row.
 * The band is committed before the trusted event becomes visible.
 */
export async function emitPersistedContextPressure(
  params: CheckSessionContextPressureParams & {
    continuationEnabled: boolean;
    agentId?: string;
    storePath: string;
    expectedSessionId?: string;
  },
): Promise<CheckContextPressureResult> {
  if (!params.continuationEnabled) {
    return { fired: false, band: 0 };
  }

  let evaluation: SessionContextPressureEvaluation | undefined;
  const persisted = await patchSessionEntryCore(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    (current) => {
      if (
        params.expectedSessionId !== undefined &&
        current.sessionId !== params.expectedSessionId
      ) {
        evaluation = undefined;
        return null;
      }
      evaluation = evaluateSessionContextPressure({
        ...params,
        sessionEntry: {
          ...current,
          totalTokens: params.sessionEntry.totalTokens,
          totalTokensFresh: params.sessionEntry.totalTokensFresh,
        },
      });
      return evaluation.fired ? { lastContextPressureBand: evaluation.band } : null;
    },
    { preserveActivity: true },
  );
  if (!persisted || !evaluation?.fired) {
    return { fired: false, band: evaluation?.band ?? 0 };
  }
  return publishSessionContextPressure(params, evaluation);
}

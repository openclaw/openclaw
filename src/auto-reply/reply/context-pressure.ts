import type { SessionEntry } from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("continuation/context-pressure");

export interface CheckContextPressureParams {
  sessionEntry: SessionEntry;
  sessionKey: string;
  contextPressureThreshold: number | undefined;
  contextWindowTokens: number;
}

export interface CheckContextPressureResult {
  fired: boolean;
  band: number;
}

/**
 * Check whether the session's token usage has crossed a context-pressure
 * threshold band and, if so, enqueue a `[system:context-pressure]` event.
 *
 * Bands are fixed at 90 and 95; the first band uses the configured threshold
 * rounded to percentage (e.g. 0.8 → 80, 0.5 → 50). Dedup is via
 * `lastContextPressureBand` on the session entry — each band fires once.
 *
 * Returns `{ fired, band }` so callers can persist the band to the session store.
 */
export function checkContextPressure(
  params: CheckContextPressureParams,
): CheckContextPressureResult {
  const { sessionEntry, sessionKey, contextPressureThreshold, contextWindowTokens } = params;

  // Guard: feature disabled or no usable data.
  // Zod rejects 0 because "fire on empty session" is not a useful configuration.
  // Negative totalTokens (data corruption) produces a negative ratio which falls below
  // all band thresholds → band = 0 → no event. Safe by arithmetic, not by explicit guard.
  if (
    contextPressureThreshold == null ||
    contextWindowTokens <= 0 ||
    sessionEntry.totalTokens == null ||
    sessionEntry.totalTokens <= 0 ||
    sessionEntry.totalTokensFresh === false
  ) {
    return { fired: false, band: 0 };
  }

  // Clamp ratio to [0, ∞) — negative should not occur after the guard above,
  // but defensive. Ratios > 1.0 are valid (token overrun).
  const ratio = Math.max(0, sessionEntry.totalTokens / contextWindowTokens);
  const thresholdPct = Math.round(contextPressureThreshold * 100);
  const bandThresholds = [
    { threshold: contextPressureThreshold, band: thresholdPct },
    ...(contextPressureThreshold < 0.9 ? [{ threshold: 0.9, band: 90 }] : []),
    ...(Math.max(contextPressureThreshold, 0.9) < 0.95 ? [{ threshold: 0.95, band: 95 }] : []),
  ];
  let band = 0;
  for (const candidate of bandThresholds) {
    if (ratio >= candidate.threshold) {
      band = candidate.band;
    }
  }

  if (band === 0 || band === (sessionEntry.lastContextPressureBand ?? 0)) {
    return { fired: false, band };
  }

  const pct = Math.round(ratio * 100);
  const tokensK = Math.round(sessionEntry.totalTokens / 1000);
  const windowK = Math.round(contextWindowTokens / 1000);

  const urgency =
    band >= 95
      ? `🚨 COMPACTION IMMINENT — evacuate working state NOW. Use CONTINUE_DELEGATE to dispatch shards or write critical state to memory files immediately. This is your last chance before context resets.`
      : band >= 90
        ? `⚠️ CONTEXT WINDOW NEARLY FULL — strongly consider evacuating working state via CONTINUE_DELEGATE or memory files. Compaction will occur soon.`
        : `⚠️ CONTEXT PRESSURE — acknowledge this event and begin planning evacuation. Save important state to memory files or prepare CONTINUE_DELEGATE shards.`;

  log.debug(
    `[context-pressure:fire] band=${band} ratio=${pct}% tokens=${tokensK}k/${windowK}k session=${sessionKey}`,
  );

  enqueueSystemEvent(
    `[system:context-pressure] ${pct}% of context window consumed (${tokensK}k / ${windowK}k tokens). ${urgency}`,
    { sessionKey },
  );

  sessionEntry.lastContextPressureBand = band;
  return { fired: true, band };
}

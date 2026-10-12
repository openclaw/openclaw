import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type ContextUsage,
  type UsageLike,
} from "../agents/usage.js";

export type SessionTranscriptUsageSnapshot = {
  modelProvider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextUsage?: ContextUsage;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  costUsd?: number;
};

type TranscriptUsageSource = "sqlite" | "artifact";

function extractTranscriptUsageSnapshot(
  message: unknown,
  source: TranscriptUsageSource,
): SessionTranscriptUsageSnapshot | null {
  if (!isRecord(message)) {
    return null;
  }
  const record = message;
  if (source === "artifact" && typeof record.role === "string" && record.role !== "assistant") {
    return null;
  }
  const usageRaw = isRecord(record.usage)
    ? (record.usage as UsageLike & { cost?: { total?: unknown }; costUsd?: unknown })
    : undefined;
  const usage = normalizeUsage(usageRaw);
  const normalizedUsage = usage ?? {};
  const api =
    source === "artifact" && typeof record.api === "string" ? record.api.trim() : record.api;
  const legacyCliUsage = api === "cli" && usageRaw && usageRaw.contextUsage === undefined;
  const derivedTotalTokens = legacyCliUsage ? undefined : deriveSessionTotalTokens({ usage });
  const totalTokens =
    source === "artifact" ? asPositiveFiniteNumber(derivedTotalTokens) : derivedTotalTokens;
  const modelProvider = typeof record.provider === "string" ? record.provider.trim() : undefined;
  const model = typeof record.model === "string" ? record.model.trim() : undefined;
  const costUsd =
    source === "artifact"
      ? asNonNegativeFiniteNumber(usageRaw?.cost?.total)
      : typeof usageRaw?.cost?.total === "number" && Number.isFinite(usageRaw.cost.total)
        ? usageRaw.cost.total
        : usageRaw?.costUsd;
  const hasMeaningfulUsage =
    hasNonzeroUsage(usage) ||
    typeof totalTokens === "number" ||
    (typeof costUsd === "number" &&
      Number.isFinite(costUsd) &&
      (source === "artifact" || costUsd > 0));
  const isDeliveryMirror = modelProvider === "openclaw" && model === "delivery-mirror";
  if (!hasMeaningfulUsage && !modelProvider && !model) {
    return null;
  }
  if (isDeliveryMirror && !hasMeaningfulUsage) {
    return null;
  }
  return {
    ...(!isDeliveryMirror && modelProvider ? { modelProvider } : {}),
    ...(!isDeliveryMirror && model ? { model } : {}),
    ...(typeof normalizedUsage.input === "number" ? { inputTokens: normalizedUsage.input } : {}),
    ...(typeof normalizedUsage.output === "number" ? { outputTokens: normalizedUsage.output } : {}),
    ...(typeof normalizedUsage.cacheRead === "number"
      ? { cacheRead: normalizedUsage.cacheRead }
      : {}),
    ...(typeof normalizedUsage.cacheWrite === "number"
      ? { cacheWrite: normalizedUsage.cacheWrite }
      : {}),
    ...(legacyCliUsage
      ? { contextUsage: { state: "unavailable" } as const }
      : normalizedUsage.contextUsage
        ? { contextUsage: normalizedUsage.contextUsage }
        : {}),
    ...(typeof totalTokens === "number" ? { totalTokens, totalTokensFresh: true } : {}),
    ...(typeof costUsd === "number" && Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

function estimateTranscriptMessageChars(message: unknown): number {
  if (!isRecord(message)) {
    return 0;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() ? estimateStringChars(content.trim()) : 0;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.reduce<number>((total, part) => {
    if (!isRecord(part)) {
      return total;
    }
    const { text, type } = part;
    if (
      typeof text !== "string" ||
      (typeof type === "string" &&
        type !== "text" &&
        type !== "output_text" &&
        type !== "input_text")
    ) {
      return total;
    }
    const normalized = text.trim();
    return normalized ? total + estimateStringChars(normalized) : total;
  }, 0);
}

export function createSessionTranscriptUsageAccumulator(source: TranscriptUsageSource = "sqlite") {
  const aggregate: SessionTranscriptUsageSnapshot = {};
  let sawUsage = false;
  const summedFields = [
    "inputTokens",
    "outputTokens",
    "cacheRead",
    "cacheWrite",
    "costUsd",
  ] as const;
  const totals: Pick<SessionTranscriptUsageSnapshot, (typeof summedFields)[number]> = {};
  let estimatedTranscriptChars = 0;
  let sawEstimateModelIdentity = false;
  // Per-entry counts for the current estimate window, so a boundary can keep
  // the retained tail it names instead of restarting from zero.
  const estimateWindow: Array<{ id?: string; chars: number; modelIdentity: boolean }> = [];
  const restartEstimateWindow = (marker: Record<string, unknown>): void => {
    const firstKeptEntryId =
      typeof marker.firstKeptEntryId === "string" ? marker.firstKeptEntryId : undefined;
    const keptIndex = firstKeptEntryId
      ? estimateWindow.findIndex((entry) => entry.id === firstKeptEntryId)
      : -1;
    // Same contract as the tree selector: an unknown kept target drops the
    // whole pre-boundary window.
    const kept = keptIndex >= 0 ? estimateWindow.slice(keptIndex) : [];
    estimateWindow.length = 0;
    estimateWindow.push(...kept);
    estimatedTranscriptChars = kept.reduce((total, entry) => total + entry.chars, 0);
    // The compaction summary stays in the model context until the next
    // boundary, so it counts even though it is not a message entry.
    const summary = typeof marker.summary === "string" ? marker.summary.trim() : "";
    if (marker.type === "compaction" && summary) {
      estimatedTranscriptChars += estimateStringChars(summary);
    }
    // A boundary is only written by a live model session, so a window it
    // leaves with counted text stays estimate-eligible even when no
    // model-tagged assistant survived the cut. Without this, a read between
    // the boundary and the next assistant reply drops the estimate for
    // summary-only or retained-user-only windows.
    sawEstimateModelIdentity =
      kept.some((entry) => entry.modelIdentity) || estimatedTranscriptChars > 0;
  };
  const add = (message: unknown, entryId?: string): void => {
    if (source === "artifact" && isRecord(message)) {
      // A compaction/reset boundary starts a fresh context window: content
      // before it is superseded history except the retained tail the marker
      // names. Usage snapshots below still aggregate across the whole record.
      if (message.type === "compaction" || message.type === "reset") {
        restartEstimateWindow(message);
        return;
      }
      const provider = typeof message.provider === "string" ? message.provider.trim() : undefined;
      const model = typeof message.model === "string" ? message.model.trim() : undefined;
      if (
        (message.role === "user" || message.role === "assistant") &&
        !(message.role === "assistant" && provider === "openclaw" && model === "delivery-mirror")
      ) {
        const estimatedChars = estimateTranscriptMessageChars(message);
        estimatedTranscriptChars += estimatedChars;
        const modelIdentity =
          message.role === "assistant" && estimatedChars > 0 && Boolean(provider || model);
        sawEstimateModelIdentity ||= modelIdentity;
        estimateWindow.push({ id: entryId, chars: estimatedChars, modelIdentity });
      } else if (entryId !== undefined) {
        // Uncounted roles stay addressable: a boundary may name one as its
        // first kept entry, and the counted tail behind it survives the cut.
        estimateWindow.push({ id: entryId, chars: 0, modelIdentity: false });
      }
    }
    const snapshot = extractTranscriptUsageSnapshot(message, source);
    if (!snapshot) {
      return;
    }
    sawUsage = true;
    if (snapshot.modelProvider) {
      aggregate.modelProvider = snapshot.modelProvider;
    }
    if (snapshot.model) {
      aggregate.model = snapshot.model;
    }
    for (const field of summedFields) {
      const value = snapshot[field];
      if (typeof value === "number") {
        totals[field] = (totals[field] ?? 0) + value;
      }
    }
    if (snapshot.contextUsage) {
      aggregate.contextUsage = snapshot.contextUsage;
    } else if (typeof snapshot.totalTokens === "number") {
      delete aggregate.contextUsage;
    }
    if (snapshot.contextUsage?.state === "unavailable") {
      // Match JSONL aggregation: the marker clears older context until a later
      // per-call snapshot replaces it during this forward scan.
      delete aggregate.totalTokens;
      delete aggregate.totalTokensFresh;
    } else if (typeof snapshot.totalTokens === "number") {
      aggregate.totalTokens = snapshot.totalTokens;
      aggregate.totalTokensFresh = true;
    }
  };
  const finish = (): SessionTranscriptUsageSnapshot | null => {
    if (!sawUsage) {
      return null;
    }
    for (const field of summedFields) {
      const value = totals[field];
      if (typeof value === "number") {
        aggregate[field] = value;
      }
    }
    if (
      source === "artifact" &&
      typeof aggregate.totalTokens !== "number" &&
      aggregate.contextUsage?.state !== "unavailable" &&
      estimatedTranscriptChars > 0 &&
      sawEstimateModelIdentity
    ) {
      const estimatedTotalTokens = estimateTokensFromChars(estimatedTranscriptChars);
      if (estimatedTotalTokens > 0) {
        aggregate.totalTokens = estimatedTotalTokens;
        aggregate.totalTokensFresh = true;
      }
    }
    return aggregate;
  };
  return { add, finish };
}

export function aggregateSessionTranscriptUsage(
  messages: unknown[],
  source: TranscriptUsageSource = "sqlite",
): SessionTranscriptUsageSnapshot | null {
  const usage = createSessionTranscriptUsageAccumulator(source);
  for (const message of messages) {
    usage.add(message);
  }
  return usage.finish();
}

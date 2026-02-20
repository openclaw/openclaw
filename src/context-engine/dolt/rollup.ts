import { createHash } from "node:crypto";
import type { DoltRecord, DoltStore } from "./store/types.js";
import {
  summarizeDoltRollup,
  type DoltRollupPromptTemplateId,
  type DoltSummaryModelSelection,
  type DoltSummarySourceTurn,
} from "./summarizer.js";

export type DoltRollupLevel = "leaf" | "bindle";

export type DoltRollupParams = {
  store: DoltStore;
  sessionId: string;
  sessionKey?: string | null;
  targetLevel: DoltRollupLevel;
  sourceRecords: DoltRecord[];
  pointer?: string;
  finalizedAtReset?: boolean;
  mode?: DoltRollupPromptTemplateId;
  provider?: string;
  model?: string;
  providerOverride?: string;
  modelOverride?: string;
  summarize?: typeof summarizeDoltRollup;
};

export type DoltRollupResult = {
  parentRecord: DoltRecord;
  childPointers: string[];
  mode: DoltRollupPromptTemplateId;
  modelSelection: DoltSummaryModelSelection;
};

/**
 * Execute one bounded Dolt rollup operation and persist parent+lineage state.
 *
 * Supported paths only:
 * - turn -> leaf
 * - leaf -> bindle
 */
export async function executeDoltRollup(params: DoltRollupParams): Promise<DoltRollupResult> {
  const sessionId = requireNonEmptyString(params.sessionId, "sessionId");
  const sourceRecords = normalizeSourceRecords(params.sourceRecords);
  const targetLevel = params.targetLevel;
  const expectedSourceLevel = expectedSourceLevelForTarget(targetLevel);

  if (sourceRecords.length === 0) {
    throw new Error("Dolt rollup requires at least one source record.");
  }

  for (const sourceRecord of sourceRecords) {
    if (sourceRecord.sessionId !== sessionId) {
      throw new Error(
        `Dolt rollup source session mismatch: expected ${sessionId}, received ${sourceRecord.sessionId}.`,
      );
    }
    if (sourceRecord.level !== expectedSourceLevel) {
      throw new Error(
        `Dolt rollup target ${targetLevel} expects ${expectedSourceLevel} sources; received ${sourceRecord.pointer} (${sourceRecord.level}).`,
      );
    }
  }

  const mode = resolveRollupMode({
    targetLevel,
    requestedMode: params.mode,
  });
  const childPointers = sourceRecords.map((record) => record.pointer);
  const first = sourceRecords[0];
  const last = sourceRecords[sourceRecords.length - 1];
  const datesCovered = {
    startEpochMs: first.eventTsMs,
    endEpochMs: last.eventTsMs,
  };
  const summarize = params.summarize ?? summarizeDoltRollup;
  const summarized = await summarize({
    sourceTurns: sourceRecords.map(toSummarySourceTurn),
    mode,
    datesCovered,
    childPointers,
    finalizedAtReset: params.finalizedAtReset,
    provider: params.provider,
    model: params.model,
    providerOverride: params.providerOverride,
    modelOverride: params.modelOverride,
  });

  const pointer =
    normalizeOptionalString(params.pointer) ??
    buildRollupPointer({
      sessionId,
      targetLevel,
      datesCovered,
      childPointers,
    });
  const parentRecord = params.store.upsertRecord({
    pointer,
    sessionId,
    sessionKey: params.sessionKey,
    level: targetLevel,
    eventTsMs: datesCovered.endEpochMs,
    payload: {
      summary: summarized.summary,
      metadata: summarized.metadata,
      modelSelection: summarized.modelSelection,
      sourcePointers: childPointers,
    },
    finalizedAtReset: summarized.metadata.finalized_at_reset,
  });

  params.store.replaceDirectChildren({
    parentPointer: parentRecord.pointer,
    children: sourceRecords.map((record, index) => ({
      pointer: record.pointer,
      level: record.level,
      index,
    })),
  });
  params.store.upsertActiveLane({
    sessionId,
    sessionKey: params.sessionKey,
    level: targetLevel,
    pointer: parentRecord.pointer,
    isActive: true,
    lastEventTsMs: parentRecord.eventTsMs,
  });

  // Selected inputs are compacted into the new summary record.
  for (const sourceRecord of sourceRecords) {
    params.store.upsertActiveLane({
      sessionId,
      sessionKey: sourceRecord.sessionKey,
      level: sourceRecord.level,
      pointer: sourceRecord.pointer,
      isActive: false,
      lastEventTsMs: parentRecord.eventTsMs,
    });
  }

  return {
    parentRecord,
    childPointers,
    mode,
    modelSelection: summarized.modelSelection,
  };
}

function resolveRollupMode(params: {
  targetLevel: DoltRollupLevel;
  requestedMode: DoltRollupPromptTemplateId | undefined;
}): DoltRollupPromptTemplateId {
  if (!params.requestedMode) {
    return params.targetLevel === "leaf" ? "leaf" : "bindle";
  }
  if (params.targetLevel === "leaf" && params.requestedMode !== "leaf") {
    throw new Error(
      `Dolt rollup mode "${params.requestedMode}" is invalid for leaf target; expected "leaf".`,
    );
  }
  if (params.targetLevel === "bindle" && params.requestedMode === "leaf") {
    throw new Error(`Dolt rollup mode "leaf" is invalid for bindle target.`);
  }
  return params.requestedMode;
}

function expectedSourceLevelForTarget(targetLevel: DoltRollupLevel): DoltRecord["level"] {
  return targetLevel === "leaf" ? "turn" : "leaf";
}

function normalizeSourceRecords(records: DoltRecord[]): DoltRecord[] {
  return [...records].toSorted(
    (a, b) => a.eventTsMs - b.eventTsMs || a.pointer.localeCompare(b.pointer),
  );
}

function toSummarySourceTurn(record: DoltRecord): DoltSummarySourceTurn {
  const payload = toRecord(record.payload);
  const summaryText = typeof payload?.summary === "string" ? payload.summary : null;
  const role = typeof payload?.role === "string" ? payload.role : "assistant";
  const contentCandidate =
    summaryText ??
    (payload && "content" in payload ? (payload as { content?: unknown }).content : record.payload);

  return {
    pointer: record.pointer,
    role,
    content: stringifyContent(contentCandidate),
    timestampMs: record.eventTsMs,
    safetyRelevantToolOutcome:
      typeof payload?.safetyRelevantToolOutcome === "boolean"
        ? payload.safetyRelevantToolOutcome
        : undefined,
  };
}

function buildRollupPointer(params: {
  sessionId: string;
  targetLevel: DoltRollupLevel;
  datesCovered: { startEpochMs: number; endEpochMs: number };
  childPointers: string[];
}): string {
  const digest = createHash("sha256")
    .update(
      [
        params.sessionId,
        params.targetLevel,
        String(params.datesCovered.startEpochMs),
        String(params.datesCovered.endEpochMs),
        ...params.childPointers,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 12);
  return `${params.targetLevel}:${params.sessionId}:${params.datesCovered.endEpochMs}:${digest}`;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    });
    const joined = parts.join("").trim();
    if (joined) {
      return joined;
    }
  }
  return safeJsonStringify(value);
}

function safeJsonStringify(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return trimmed;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

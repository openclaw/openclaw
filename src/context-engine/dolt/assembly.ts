import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  resolveDoltLanePolicies,
  type DoltLanePolicy,
  type DoltLanePolicyOverrides,
  type DoltLanePolicies,
} from "./policy.js";
import type { DoltRecord, DoltRecordLevel, DoltStore } from "./store/types.js";
import { collectDoltActiveLaneSnapshot, emitDoltTelemetryEvent } from "./telemetry.js";

export type DoltAssemblyParams = {
  store: DoltStore;
  sessionId: string;
  tokenBudget?: number;
  runtimeReserveTokens?: number;
  lanePolicies?: DoltLanePolicies;
  lanePolicyOverrides?: DoltLanePolicyOverrides;
};

export type DoltAssemblyBudget = {
  availableTokens: number;
  runtimeReserveTokens: number;
  laneBudgets: {
    bindle: number;
    leaf: number;
    turn: number;
  };
};

export type DoltAssemblyResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  budget: DoltAssemblyBudget;
  selectedRecords: {
    bindle: DoltRecord[];
    leaf: DoltRecord[];
    turn: DoltRecord[];
  };
};

/**
 * Assemble bounded context from active Dolt lanes under fixed per-lane budgets.
 *
 * Selection policy:
 * - Recency-aware within each lane (newest-first selection pass)
 * - Output order always <bindles><leaves><turns>, oldest->newest in each bucket
 * - Each selected record is emitted as one message (never merged)
 */
export function assembleDoltContext(params: DoltAssemblyParams): DoltAssemblyResult {
  const sessionId = requireNonEmptyString(params.sessionId, "sessionId");
  const lanePolicies =
    params.lanePolicies ?? resolveDoltLanePolicies(params.lanePolicyOverrides ?? undefined);
  const tokenBudget = normalizeNonNegativeInt(params.tokenBudget ?? 0);
  const runtimeReserveTokens = normalizeNonNegativeInt(params.runtimeReserveTokens ?? 0);
  const availableTokens = Math.max(0, tokenBudget - runtimeReserveTokens);
  const laneBudgets = resolveDoltAssemblyLaneBudgets({
    availableTokens,
    lanePolicies,
  });

  const bindles = selectLaneByRecency({
    store: params.store,
    sessionId,
    level: "bindle",
    laneBudget: laneBudgets.bindle,
  });
  const leaves = selectLaneByRecency({
    store: params.store,
    sessionId,
    level: "leaf",
    laneBudget: laneBudgets.leaf,
  });
  const turns = selectLaneByRecency({
    store: params.store,
    sessionId,
    level: "turn",
    laneBudget: laneBudgets.turn,
  });

  const orderedBindles = oldestFirst(bindles);
  const orderedLeaves = oldestFirst(leaves);
  const orderedTurns = oldestFirst(turns);
  const orderedRecords = [...orderedBindles, ...orderedLeaves, ...orderedTurns];
  const messages = orderedRecords.map(toAgentMessage);
  const estimatedTokens = orderedRecords.reduce((sum, record) => sum + record.tokenCount, 0);
  const laneActiveSnapshot = collectDoltActiveLaneSnapshot({
    store: params.store,
    sessionId,
  });
  const lane_selected_record_counts = {
    bindle: orderedBindles.length,
    leaf: orderedLeaves.length,
    turn: orderedTurns.length,
  };
  const lane_selected_token_totals = {
    bindle: sumRecordTokens(orderedBindles),
    leaf: sumRecordTokens(orderedLeaves),
    turn: sumRecordTokens(orderedTurns),
  };

  emitDoltTelemetryEvent({
    event_type: "dolt_assembly_snapshot",
    session_id: sessionId,
    payload: {
      token_budget: tokenBudget,
      runtime_reserve_tokens: runtimeReserveTokens,
      available_tokens: availableTokens,
      lane_budget_tokens: laneBudgets,
      lane_selected_record_counts,
      lane_selected_token_totals,
      lane_active_record_counts: laneActiveSnapshot.lane_active_record_counts,
      lane_active_token_totals: laneActiveSnapshot.lane_active_token_totals,
    },
  });

  return {
    messages,
    estimatedTokens,
    budget: {
      availableTokens,
      runtimeReserveTokens,
      laneBudgets,
    },
    selectedRecords: {
      bindle: orderedBindles,
      leaf: orderedLeaves,
      turn: orderedTurns,
    },
  };
}

// ---------------------------------------------------------------------------
// Context snapshot — lightweight JSON file written after each assembly so
// external tools (TUI, watch, jq) can inspect the live bounded context.
// ---------------------------------------------------------------------------

/** Shape of the JSON snapshot written to disk after assembly. */
export type DoltContextSnapshot = {
  sessionId: string;
  assembledAt: string;
  estimatedTokens: number;
  budget: DoltAssemblyBudget;
  lanes: {
    bindle: DoltContextSnapshotRecord[];
    leaf: DoltContextSnapshotRecord[];
    turn: DoltContextSnapshotRecord[];
  };
};

export type DoltContextSnapshotRecord = {
  pointer: string;
  tokenCount: number;
  eventTsMs: number;
  level: DoltRecordLevel;
};

/**
 * Write a JSON snapshot of the most recent assembly result to disk.
 *
 * The file is a plain JSON object whose `lanes` arrays contain pointers
 * into the SQLite store — not the full record payloads.  External tools
 * can poll this file and join against the DB for full content when needed.
 *
 * Writes are atomic (write-to-tmp then rename) to avoid partial reads.
 */
export function writeDoltContextSnapshot(params: {
  result: DoltAssemblyResult;
  sessionId: string;
  snapshotPath: string;
}): void {
  const toSnapshotRecord = (r: DoltRecord): DoltContextSnapshotRecord => ({
    pointer: r.pointer,
    tokenCount: r.tokenCount,
    eventTsMs: r.eventTsMs,
    level: r.level,
  });

  const snapshot: DoltContextSnapshot = {
    sessionId: params.sessionId,
    assembledAt: new Date().toISOString(),
    estimatedTokens: params.result.estimatedTokens,
    budget: params.result.budget,
    lanes: {
      bindle: params.result.selectedRecords.bindle.map(toSnapshotRecord),
      leaf: params.result.selectedRecords.leaf.map(toSnapshotRecord),
      turn: params.result.selectedRecords.turn.map(toSnapshotRecord),
    },
  };

  // Atomic write: tmp file then rename to avoid partial reads from pollers.
  const dir = path.dirname(params.snapshotPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${params.snapshotPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), "utf-8");
  fs.renameSync(tmpPath, params.snapshotPath);
}

/**
 * Resolve per-lane token budgets from total available context tokens.
 */
export function resolveDoltAssemblyLaneBudgets(params: {
  availableTokens: number;
  lanePolicies: DoltLanePolicies;
}): {
  bindle: number;
  leaf: number;
  turn: number;
} {
  const bindleCap = resolveDoltLaneCap(params.lanePolicies.bindle);
  const leafCap = resolveDoltLaneCap(params.lanePolicies.leaf);
  const turnCap = resolveDoltTurnAssemblyCap(params.lanePolicies.turn);

  let remaining = params.availableTokens;
  const bindle = Math.min(remaining, bindleCap);
  remaining -= bindle;
  const leaf = Math.min(remaining, leafCap);
  remaining -= leaf;
  const turn = Math.min(remaining, turnCap);

  return { bindle, leaf, turn };
}

/**
 * Resolve hard cap for one lane from policy target/summary cap fields.
 */
export function resolveDoltLaneCap(policy: DoltLanePolicy): number {
  if (typeof policy.summaryCap === "number") {
    return normalizeNonNegativeInt(policy.summaryCap);
  }
  return normalizeNonNegativeInt(policy.target);
}

/**
 * Keep turn assembly capacity at or above the compaction trigger threshold.
 *
 * This avoids a dead zone where assembly drops old turns before compaction can
 * roll them up into leaf summaries.
 */
function resolveDoltTurnAssemblyCap(policy: DoltLanePolicy): number {
  const laneCap = resolveDoltLaneCap(policy);
  const compactionTrigger = normalizeNonNegativeInt(policy.soft + policy.delta);
  return Math.max(laneCap, compactionTrigger);
}

function selectLaneByRecency(params: {
  store: DoltStore;
  sessionId: string;
  level: DoltRecordLevel;
  laneBudget: number;
}): DoltRecord[] {
  if (params.laneBudget <= 0) {
    return [];
  }
  const activePointers = params.store.listActiveLane({
    sessionId: params.sessionId,
    level: params.level,
    activeOnly: true,
  });
  const recordsNewestFirst = activePointers
    .map((laneEntry) => params.store.getRecord(laneEntry.pointer))
    .filter((record): record is DoltRecord => !!record)
    .filter((record) => record.sessionId === params.sessionId && record.level === params.level)
    .toSorted((a, b) => b.eventTsMs - a.eventTsMs || b.pointer.localeCompare(a.pointer));

  // Keep the newest prefix that fits the lane budget; this drops older entries first.
  const selectedNewestFirst: DoltRecord[] = [];
  let usedTokens = 0;
  for (const record of recordsNewestFirst) {
    if (usedTokens + record.tokenCount > params.laneBudget) {
      break;
    }
    selectedNewestFirst.push(record);
    usedTokens += record.tokenCount;
  }
  return selectedNewestFirst;
}

function oldestFirst(records: DoltRecord[]): DoltRecord[] {
  return [...records].toSorted(
    (a, b) => a.eventTsMs - b.eventTsMs || a.pointer.localeCompare(b.pointer),
  );
}

function sumRecordTokens(records: DoltRecord[]): number {
  return records.reduce((sum, record) => sum + normalizeNonNegativeInt(record.tokenCount), 0);
}

function toAgentMessage(record: DoltRecord): AgentMessage {
  const payload = toRecord(record.payload);
  const summary = typeof payload?.summary === "string" ? payload.summary : null;
  if (summary) {
    return {
      role: "assistant",
      content: summary,
    } as unknown as AgentMessage;
  }

  const payloadRole = typeof payload?.role === "string" ? payload.role : null;
  if (payloadRole && payload && "content" in payload) {
    return {
      role: payloadRole,
      content: (payload as { content?: unknown }).content ?? "",
    } as unknown as AgentMessage;
  }

  return {
    role: record.level === "turn" ? "user" : "assistant",
    content: safeJsonStringify(record.payload),
  } as unknown as AgentMessage;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
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

function normalizeNonNegativeInt(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
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

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { DoltRecord, DoltRecordLevel, DoltStore } from "./store/types.js";
import {
  resolveDoltLanePolicies,
  type DoltLanePolicy,
  type DoltLanePolicyOverrides,
  type DoltLanePolicies,
} from "./policy.js";

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
  const laneBudgets = resolveLaneBudgets({
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

function resolveLaneBudgets(params: { availableTokens: number; lanePolicies: DoltLanePolicies }): {
  bindle: number;
  leaf: number;
  turn: number;
} {
  const bindleCap = resolveLaneCap(params.lanePolicies.bindle);
  const leafCap = resolveLaneCap(params.lanePolicies.leaf);
  const turnCap = resolveLaneCap(params.lanePolicies.turn);

  let remaining = params.availableTokens;
  const bindle = Math.min(remaining, bindleCap);
  remaining -= bindle;
  const leaf = Math.min(remaining, leafCap);
  remaining -= leaf;
  const turn = Math.min(remaining, turnCap);

  return { bindle, leaf, turn };
}

function resolveLaneCap(policy: DoltLanePolicy): number {
  if (typeof policy.summaryCap === "number") {
    return normalizeNonNegativeInt(policy.summaryCap);
  }
  return normalizeNonNegativeInt(policy.target);
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

function toAgentMessage(record: DoltRecord): AgentMessage {
  const payload = toRecord(record.payload);
  const summary = typeof payload?.summary === "string" ? payload.summary : null;
  if (summary) {
    return {
      role: "assistant",
      content: summary,
    } as AgentMessage;
  }

  const payloadRole = typeof payload?.role === "string" ? payload.role : null;
  if (payloadRole && payload && "content" in payload) {
    return {
      role: payloadRole,
      content: (payload as { content?: unknown }).content ?? "",
    } as AgentMessage;
  }

  return {
    role: record.level === "turn" ? "user" : "assistant",
    content: safeJsonStringify(record.payload),
  } as AgentMessage;
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

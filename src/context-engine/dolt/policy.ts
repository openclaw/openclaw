import { createHash } from "node:crypto";
import type { DoltRecordLevel } from "./store/types.js";
import { renderPayloadForTokenEstimation } from "./store/token-count.js";

export type DoltLanePolicy = {
  soft: number;
  delta: number;
  target: number;
  summaryCap?: number;
};

export type DoltLanePolicyOverrides = Partial<Record<DoltRecordLevel, Partial<DoltLanePolicy>>>;

export type DoltLanePolicies = Record<DoltRecordLevel, DoltLanePolicy>;

export type DoltLanePressureDecision = {
  shouldCompact: boolean;
  trigger: "none" | "soft_delta" | "hard_limit_bypass" | "drain";
  nextDrainMode: boolean;
  softTriggerThreshold: number;
  pressureDelta: number;
};

export type DoltTurnChunkCandidate = {
  pointer: string;
  tokenCount: number;
};

export type DoltTurnChunkSelection = {
  selected: DoltTurnChunkCandidate[];
  selectedTokenCount: number;
  selectedCount: number;
  freshTailCount: number;
  freshTailTokenCount: number;
  pressureDelta: number;
  maxSelectableCount: number;
};

export type DoltTurnAccountingIntercept = {
  payload: unknown;
  intercepted: boolean;
  sourceTokenEstimate: number;
  sourceByteLength: number;
};

export const DOLT_TURN_FRESH_TAIL_MIN_TURNS = 2;
export const DOLT_TURN_FRESH_TAIL_TOKEN_LIMIT = 10_000;
export const DOLT_TURN_CHUNK_MIN_TURNS = 2;
export const DOLT_OUTLIER_INTERCEPT_TOKEN_LIMIT = 10_000;
export const DOLT_OUTLIER_INTERCEPT_PREVIEW_CHARS = 512;

export const DOLT_LANE_POLICIES_DEFAULT: DoltLanePolicies = {
  turn: {
    soft: 40_000,
    delta: 4_000,
    target: 36_000,
  },
  leaf: {
    soft: 10_000,
    delta: 1_000,
    target: 9_000,
    summaryCap: 2_000,
  },
  bindle: {
    soft: 10_000,
    delta: 1_000,
    target: 9_000,
    summaryCap: 2_000,
  },
};

/**
 * Resolve lane policy defaults with optional per-lane overrides.
 */
export function resolveDoltLanePolicies(overrides?: DoltLanePolicyOverrides): DoltLanePolicies {
  const turn = resolveOneLanePolicy("turn", overrides?.turn);
  const leaf = resolveOneLanePolicy("leaf", overrides?.leaf);
  const bindle = resolveOneLanePolicy("bindle", overrides?.bindle);
  return {
    turn,
    leaf,
    bindle,
  };
}

/**
 * Evaluate whether a lane should compact under hysteresis and hard-limit rules.
 */
export function evaluateDoltLanePressure(params: {
  laneTokenCount: number;
  policy: DoltLanePolicy;
  drainMode?: boolean;
  hardLimitSafetyMode?: boolean;
}): DoltLanePressureDecision {
  const laneTokenCount = normalizeNonNegativeInt(params.laneTokenCount, 0);
  const policy = normalizeLanePolicy(params.policy);
  const softTriggerThreshold = policy.soft + policy.delta;
  const pressureDelta = Math.max(0, laneTokenCount - policy.target);
  const overTarget = laneTokenCount > policy.target;

  if (params.drainMode === true && overTarget) {
    return {
      shouldCompact: true,
      trigger: "drain",
      nextDrainMode: true,
      softTriggerThreshold,
      pressureDelta,
    };
  }

  if (params.hardLimitSafetyMode === true && overTarget) {
    return {
      shouldCompact: true,
      trigger: "hard_limit_bypass",
      nextDrainMode: true,
      softTriggerThreshold,
      pressureDelta,
    };
  }

  if (laneTokenCount > softTriggerThreshold) {
    return {
      shouldCompact: true,
      trigger: "soft_delta",
      nextDrainMode: true,
      softTriggerThreshold,
      pressureDelta,
    };
  }

  return {
    shouldCompact: false,
    trigger: "none",
    nextDrainMode: false,
    softTriggerThreshold,
    pressureDelta,
  };
}

/**
 * Select a bounded oldest-first turn chunk while preserving a fresh tail.
 */
export function selectDoltTurnChunkForCompaction(params: {
  turns: DoltTurnChunkCandidate[];
  laneTokenCount: number;
  policy: DoltLanePolicy;
  freshTailTokenLimit?: number;
  freshTailMinTurns?: number;
  minChunkTurns?: number;
}): DoltTurnChunkSelection {
  const turns = (params.turns ?? []).map((turn) => ({
    pointer: turn.pointer,
    tokenCount: normalizeNonNegativeInt(turn.tokenCount, 0),
  }));
  const policy = normalizeLanePolicy(params.policy);
  const freshTailTokenLimit = normalizeNonNegativeInt(
    params.freshTailTokenLimit ?? DOLT_TURN_FRESH_TAIL_TOKEN_LIMIT,
    DOLT_TURN_FRESH_TAIL_TOKEN_LIMIT,
  );
  const freshTailMinTurns = Math.max(
    1,
    normalizeNonNegativeInt(
      params.freshTailMinTurns ?? DOLT_TURN_FRESH_TAIL_MIN_TURNS,
      DOLT_TURN_FRESH_TAIL_MIN_TURNS,
    ),
  );
  const minChunkTurns = Math.max(
    1,
    normalizeNonNegativeInt(
      params.minChunkTurns ?? DOLT_TURN_CHUNK_MIN_TURNS,
      DOLT_TURN_CHUNK_MIN_TURNS,
    ),
  );
  const freshTail = resolveFreshTailWindow({
    turns,
    freshTailTokenLimit,
    freshTailMinTurns,
  });
  const maxSelectableCount = Math.max(0, turns.length - freshTail.freshTailCount);
  const pressureDelta = Math.max(
    0,
    normalizeNonNegativeInt(params.laneTokenCount, 0) - policy.target,
  );

  if (maxSelectableCount < minChunkTurns) {
    return {
      selected: [],
      selectedTokenCount: 0,
      selectedCount: 0,
      freshTailCount: freshTail.freshTailCount,
      freshTailTokenCount: freshTail.freshTailTokenCount,
      pressureDelta,
      maxSelectableCount,
    };
  }

  let selectedCount = 0;
  let selectedTokenCount = 0;
  for (let i = 0; i < maxSelectableCount; i += 1) {
    selectedTokenCount += turns[i]?.tokenCount ?? 0;
    selectedCount += 1;

    if (selectedCount >= minChunkTurns && selectedTokenCount >= pressureDelta) {
      break;
    }
  }

  selectedCount = Math.max(minChunkTurns, selectedCount);
  selectedCount = Math.min(maxSelectableCount, selectedCount);
  const selected = turns.slice(0, selectedCount);
  selectedTokenCount = selected.reduce((sum, turn) => sum + turn.tokenCount, 0);

  return {
    selected,
    selectedTokenCount,
    selectedCount,
    freshTailCount: freshTail.freshTailCount,
    freshTailTokenCount: freshTail.freshTailTokenCount,
    pressureDelta,
    maxSelectableCount,
  };
}

/**
 * Convert oversized turn payloads into deterministic bounded accounting payloads.
 */
export function interceptDoltTurnPayloadForAccounting(params: {
  payload: unknown;
  tokenLimit?: number;
  previewChars?: number;
}): DoltTurnAccountingIntercept {
  const payloadText = renderPayloadForTokenEstimation(params.payload);
  const sourceByteLength = Buffer.byteLength(payloadText, "utf8");
  const sourceTokenEstimate = estimateTokensFromBytes(sourceByteLength);
  const tokenLimit = Math.max(
    1,
    normalizeNonNegativeInt(
      params.tokenLimit ?? DOLT_OUTLIER_INTERCEPT_TOKEN_LIMIT,
      DOLT_OUTLIER_INTERCEPT_TOKEN_LIMIT,
    ),
  );

  if (sourceTokenEstimate <= tokenLimit) {
    return {
      payload: params.payload,
      intercepted: false,
      sourceTokenEstimate,
      sourceByteLength,
    };
  }

  const previewChars = Math.max(
    32,
    normalizeNonNegativeInt(
      params.previewChars ?? DOLT_OUTLIER_INTERCEPT_PREVIEW_CHARS,
      DOLT_OUTLIER_INTERCEPT_PREVIEW_CHARS,
    ),
  );
  const head = payloadText.slice(0, previewChars);
  const tail = payloadText.slice(-previewChars);
  const boundedPayload = {
    doltAccountingIntercept: {
      version: 1,
      reason: "oversized_turn_payload",
      sourceTokenEstimate,
      sourceByteLength,
      thresholdTokenLimit: tokenLimit,
      payloadSha256: createHash("sha256").update(payloadText).digest("hex"),
      previewHead: head,
      previewTail: tail,
    },
  };

  return {
    payload: boundedPayload,
    intercepted: true,
    sourceTokenEstimate,
    sourceByteLength,
  };
}

function resolveOneLanePolicy(
  level: DoltRecordLevel,
  override: Partial<DoltLanePolicy> | undefined,
): DoltLanePolicy {
  const base = DOLT_LANE_POLICIES_DEFAULT[level];
  return normalizeLanePolicy({
    soft: override?.soft ?? base.soft,
    delta: override?.delta ?? base.delta,
    target: override?.target ?? base.target,
    summaryCap: override?.summaryCap ?? base.summaryCap,
  });
}

function normalizeLanePolicy(policy: DoltLanePolicy): DoltLanePolicy {
  const soft = normalizeNonNegativeInt(policy.soft, 0);
  const delta = normalizeNonNegativeInt(policy.delta, 0);
  const target = normalizeNonNegativeInt(policy.target, 0);
  if (target > soft) {
    throw new Error(`Dolt lane policy violation: target (${target}) must be <= soft (${soft}).`);
  }

  if (typeof policy.summaryCap === "number") {
    const summaryCap = normalizeNonNegativeInt(policy.summaryCap, 0);
    return {
      soft,
      delta,
      target,
      summaryCap,
    };
  }

  return {
    soft,
    delta,
    target,
  };
}

function resolveFreshTailWindow(params: {
  turns: DoltTurnChunkCandidate[];
  freshTailTokenLimit: number;
  freshTailMinTurns: number;
}): { freshTailCount: number; freshTailTokenCount: number } {
  if (params.turns.length === 0) {
    return {
      freshTailCount: 0,
      freshTailTokenCount: 0,
    };
  }

  let freshTailCount = 0;
  let freshTailTokenCount = 0;

  // Walk newest->oldest until adding another turn would exceed the token window.
  for (let i = params.turns.length - 1; i >= 0; i -= 1) {
    const tokenCount = params.turns[i]?.tokenCount ?? 0;

    if (freshTailCount > 0 && freshTailTokenCount + tokenCount > params.freshTailTokenLimit) {
      break;
    }

    freshTailCount += 1;
    freshTailTokenCount += tokenCount;

    if (freshTailTokenCount >= params.freshTailTokenLimit) {
      break;
    }
  }

  const constrainedCount = Math.min(
    params.turns.length,
    Math.max(params.freshTailMinTurns, freshTailCount),
  );
  const tailSlice = params.turns.slice(params.turns.length - constrainedCount);
  const constrainedTokenCount = tailSlice.reduce((sum, turn) => sum + turn.tokenCount, 0);

  return {
    freshTailCount: constrainedCount,
    freshTailTokenCount: constrainedTokenCount,
  };
}

function normalizeNonNegativeInt(value: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function estimateTokensFromBytes(utf8Bytes: number): number {
  return utf8Bytes === 0 ? 0 : Math.ceil(utf8Bytes / 4);
}

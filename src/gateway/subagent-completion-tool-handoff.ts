import { randomUUID } from "node:crypto";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  captureRequesterModelPolicySnapshot,
  intersectOperatorModelPolicies,
  restoreRequesterModelPolicySnapshot,
} from "../agents/operator-model-policy-state.js";
import type {
  PreparedOperatorModelPolicy,
  RequesterModelPolicySnapshot,
} from "../agents/operator-model-policy.types.js";
import type {
  SubagentCompletionToolHandoffRegistration,
  TrustedSubagentCompletionHandoff,
} from "../agents/subagents/announce/subagent-announce-handoff.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

const SUBAGENT_COMPLETION_TOOL_HANDOFF_TTL_MS = 5 * 60 * 1000;

type SubagentCompletionToolHandoffEntry = SubagentCompletionToolHandoffRegistration & {
  expiresAtMs: number;
  requesterModelPolicySnapshot: RequesterModelPolicySnapshot;
};

const handoffs = resolveGlobalMap<string, SubagentCompletionToolHandoffEntry>(
  Symbol.for("openclaw.subagentCompletionToolHandoffs"),
  "close-and-restart",
);

function normalizeRegistration(
  params: Partial<SubagentCompletionToolHandoffRegistration>,
): SubagentCompletionToolHandoffRegistration | undefined {
  const sourceSessionKey = normalizeOptionalString(params.sourceSessionKey);
  const sourceSessionId = normalizeOptionalString(params.sourceSessionId);
  const targetSessionKey = normalizeOptionalString(params.targetSessionKey);
  const targetSessionId = normalizeOptionalString(params.targetSessionId);
  const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
  if (!sourceSessionKey || !targetSessionKey || !targetSessionId || !idempotencyKey) {
    return undefined;
  }
  const settleBatch = params.settleBatch;
  if (
    settleBatch &&
    (!settleBatch.isCurrent() ||
      settleBatch.sourceSessionKeys[0] !== sourceSessionKey ||
      settleBatch.sourceSessionKeys.some((key) => !key.trim()))
  ) {
    return undefined;
  }
  return {
    sourceSessionKey,
    ...(params.sourceRunIds ? { sourceRunIds: [...params.sourceRunIds] } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    targetSessionKey,
    targetSessionId,
    idempotencyKey,
    ...(settleBatch
      ? { settleBatch: { ...settleBatch, sourceSessionKeys: [...settleBatch.sourceSessionKeys] } }
      : {}),
  };
}

function pruneExpired(nowMs: number): void {
  for (const [handoffId, entry] of handoffs) {
    if (!isFutureDateTimestampMs(entry.expiresAtMs, { nowMs })) {
      handoffs.delete(handoffId);
    }
  }
}

/** Register one short-lived capability for the exact completion delivery request. */
export function registerSubagentCompletionToolHandoff(
  params: SubagentCompletionToolHandoffRegistration & { nowMs?: number },
): string | undefined {
  const normalized = normalizeRegistration(params);
  if (!normalized) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpired(nowMs);
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(SUBAGENT_COMPLETION_TOOL_HANDOFF_TTL_MS, {
    nowMs,
  });
  if (expiresAtMs === undefined) {
    return undefined;
  }
  const handoffId = randomUUID();
  let requesterPolicy: PreparedOperatorModelPolicy | undefined;
  let requesterModelPolicySnapshot: RequesterModelPolicySnapshot;
  try {
    if (!normalized.sourceRunIds?.length) {
      throw new Error("Completion model restrictions require their recorded source runs.");
    }
    const sourceSessionKeys = normalized.settleBatch?.sourceSessionKeys ?? [
      normalized.sourceSessionKey,
    ];
    for (const runId of normalized.sourceRunIds) {
      const source = subagentRuns.get(runId);
      const matches =
        source &&
        sourceSessionKeys.includes(source.childSessionKey) &&
        source.requesterSessionKey === normalized.targetSessionKey &&
        (!source.completionRequesterSessionId ||
          source.completionRequesterSessionId === normalized.targetSessionId);
      requesterPolicy = intersectOperatorModelPolicies(
        requesterPolicy,
        restoreRequesterModelPolicySnapshot(
          matches ? source.requesterModelPolicySnapshot : undefined,
        ),
      );
    }
    requesterModelPolicySnapshot = captureRequesterModelPolicySnapshot(requesterPolicy);
  } catch {
    // Result custody is independent of whether an old task can resume inference safely.
    requesterModelPolicySnapshot = { kind: "unknown" };
  }
  handoffs.set(handoffId, { ...normalized, expiresAtMs, requesterModelPolicySnapshot });
  return handoffId;
}

/** Remove an unconsumed capability after its in-process dispatch finishes or fails. */
export function cancelSubagentCompletionToolHandoff(handoffId: string | undefined): boolean {
  const normalized = normalizeOptionalString(handoffId);
  return normalized ? handoffs.delete(normalized) : false;
}

/**
 * Consume the capability once and bind it to the model route admitted for this run.
 * Mismatches do not burn the capability; only the exact request may consume it.
 */
export function consumeSubagentCompletionToolHandoff(params: {
  handoffId?: string;
  sourceTool: string | undefined;
  sourceSessionKey?: string;
  sourceSessionId?: string;
  targetSessionKey?: string;
  targetSessionId?: string;
  idempotencyKey?: string;
  provider?: string;
  model?: string;
}): TrustedSubagentCompletionHandoff | undefined {
  const handoffId = normalizeOptionalString(params.handoffId);
  const registration = normalizeRegistration(params);
  const provider = normalizeOptionalString(params.provider)?.toLowerCase();
  const model = normalizeOptionalString(params.model);
  if (!handoffId || !registration || !provider || !model) {
    return undefined;
  }
  const { sourceSessionKey, sourceSessionId, targetSessionKey, targetSessionId, idempotencyKey } =
    registration;
  const nowMs = Date.now();
  pruneExpired(nowMs);
  const entry = handoffs.get(handoffId);
  if (
    !entry ||
    params.sourceTool !== (entry.settleBatch ? "subagent_settle" : "subagent_announce") ||
    entry.settleBatch?.isCurrent() === false ||
    (entry.settleBatch
      ? !entry.settleBatch.sourceSessionKeys.includes(sourceSessionKey)
      : entry.sourceSessionKey !== sourceSessionKey) ||
    entry.sourceSessionId !== sourceSessionId ||
    entry.targetSessionKey !== targetSessionKey ||
    entry.targetSessionId !== targetSessionId ||
    entry.idempotencyKey !== idempotencyKey
  ) {
    return undefined;
  }
  handoffs.delete(handoffId);
  return {
    kind: "subagent-completion",
    sourceSessionKey,
    ...(sourceSessionId ? { sourceSessionId } : {}),
    targetSessionKey,
    targetSessionId,
    provider,
    model,
    ...(entry.settleBatch ? { settleBatch: entry.settleBatch } : {}),
  };
}

type CompletionRequesterTarget = {
  handoffId: string | undefined;
  targetSessionKey: string;
  targetSessionId: string;
  idempotencyKey: string;
};

function findCompletionRequesterTarget(params: CompletionRequesterTarget) {
  const entry = params.handoffId ? handoffs.get(params.handoffId) : undefined;
  return entry &&
    entry.expiresAtMs > Date.now() &&
    entry.targetSessionKey === params.targetSessionKey &&
    entry.targetSessionId === params.targetSessionId &&
    entry.idempotencyKey === params.idempotencyKey
    ? entry
    : undefined;
}

/** Read restriction facts before model selection; this never consumes or grants a capability. */
export function readSubagentCompletionRequesterModelPolicy(
  params: CompletionRequesterTarget,
): RequesterModelPolicySnapshot {
  return findCompletionRequesterTarget(params)?.requesterModelPolicySnapshot ?? { kind: "unknown" };
}

/** Only a current host-recorded completion relation can qualify its own System continuation. */
export function isCurrentSubagentCompletionRequester(params: CompletionRequesterTarget): boolean {
  const entry = findCompletionRequesterTarget(params);
  return entry !== undefined && (entry.settleBatch?.isCurrent() ?? true);
}

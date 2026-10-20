import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { ReplyRunAlreadyActiveError, type ReplyOperation } from "./session-controller.contracts.js";
import {
  activeSessionOperations,
  hasOperationBackendRunId,
  findSessionControllerEntries,
  isReplyRunEvidenceStale,
  getSessionControllerOperation,
  hasReplyOperationExecutionStarted,
  isReplyOperationPreBackendPhase,
  resolveReplyRunForCurrentSessionId,
  getSessionControllerEntryForOperation,
} from "./session-controller.state.js";
import { rpcSourcesByRunId } from "./session-controller.storage.js";
import type { SessionTarget } from "./session-controller.target.js";

export function isSessionRunActive(sessionId: string): boolean {
  return resolveReplyRunForCurrentSessionId(sessionId).kind !== "none";
}

/** Native liveness is a fact of the active turn, never a second busy-state vote. */
export function resolveSessionRunProgressState(
  sessionId: string,
  owner?: { agentId?: string; defaultAgentId?: string },
): "queued" | "running" | undefined {
  const resolution = resolveReplyRunForCurrentSessionId(sessionId);
  const operations =
    resolution.kind === "none"
      ? []
      : resolution.kind === "one"
        ? [resolution.operation]
        : resolution.operations;
  const eligible = operations.filter((operation) => {
    if (operation.result) {
      return false;
    }
    if (!owner) {
      return true;
    }
    const requested = owner.agentId ?? owner.defaultAgentId;
    const recorded =
      operation.agentId ?? parseAgentSessionKey(operation.key)?.agentId ?? owner.defaultAgentId;
    const attachment = getSessionControllerEntryForOperation(operation).attachment;
    return Boolean(
      requested &&
      recorded &&
      normalizeAgentId(requested) === normalizeAgentId(recorded) &&
      attachment?.projectSessionActive !== false,
    );
  });
  if (eligible.length === 0) {
    return undefined;
  }
  if (
    eligible.every(
      (operation) =>
        operation.phase === "waiting_for_global_lane" ||
        !hasReplyOperationExecutionStarted(operation),
    )
  ) {
    return "queued";
  }
  return "running";
}
export function isSessionRunCompactionBlocked(sessionId: string): boolean {
  const resolution = resolveReplyRunForCurrentSessionId(sessionId);
  const operations =
    resolution.kind === "none"
      ? []
      : resolution.kind === "one"
        ? [resolution.operation]
        : resolution.operations;
  return operations.some((operation) => !isReplyOperationPreBackendPhase(operation.phase));
}
export function getActiveSessionRunCount(): number {
  return [...activeSessionOperations()].length;
}
export function listActiveSessionRunKeys(): string[] {
  return [...activeSessionOperations()].map((operation) => operation.key).toSorted();
}
export function listActiveSessionRunIds(): string[] {
  return [...activeSessionOperations()].map((operation) => operation.sessionId).toSorted();
}
/** Resolves the active run for one logical key, narrowed to a physical owner when provided. */
export function resolveActiveSessionRunId(
  sessionKey: string,
  target?: SessionTarget,
): string | undefined {
  return getSessionControllerOperation(sessionKey.trim(), target)?.sessionId;
}

/** A logical key is busy even when it selects multiple physical owners. */
export function isSessionRunActiveForKey(sessionKey: string): boolean {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return Boolean(
    normalizedSessionKey &&
    findSessionControllerEntries(normalizedSessionKey).some((entry) => entry.active),
  );
}

/** Reads the active operation's delivery thread without selecting an ambiguous owner. */
export function resolveActiveSessionRunThreadId(sessionKey: string): string | number | undefined {
  return getSessionControllerOperation(sessionKey)?.routeThreadId;
}

export function isReplyRunEvidenceStaleBySessionId(sessionId: string): boolean {
  const resolution = resolveReplyRunForCurrentSessionId(sessionId);
  const operations =
    resolution.kind === "none"
      ? []
      : resolution.kind === "one"
        ? [resolution.operation]
        : resolution.operations;
  return operations.some(isReplyRunEvidenceStale);
}

export function listActiveReplyRunSessionKeys(): string[] {
  return [...activeSessionOperations()].map((operation) => operation.key);
}

/** Resolves a single active physical owner, rejecting ambiguous current identities. */
export function resolveActiveReplyOperationForSessionId(
  sessionId: string,
): ReplyOperation | undefined {
  const resolution = resolveReplyRunForCurrentSessionId(sessionId);
  if (resolution.kind === "ambiguous") {
    throw new ReplyRunAlreadyActiveError(sessionId);
  }
  return resolution.kind === "one" ? resolution.operation : undefined;
}

/**
 * Resolves the one unfinished operation that owns a backend run ID (kept after detach until the
 * operation settles) or a claimed input's protocol run ID; ambiguity fails closed.
 */
export function findSessionControllerOperationByRunId(runId: string): ReplyOperation | undefined {
  const matches = new Set<ReplyOperation>();
  for (const operation of activeSessionOperations()) {
    const claim = getSessionControllerEntryForOperation(operation).mailbox?.claim;
    if (
      !operation.result &&
      (hasOperationBackendRunId(operation, runId) ||
        (claim?.operation === operation &&
          claim.inputs.some((input) => input.protocolRunId === runId)))
    ) {
      matches.add(operation);
    }
  }
  for (const source of rpcSourcesByRunId.get(runId) ?? []) {
    const claim = source.input.claim;
    if (claim && !claim.released && claim.operation && !claim.operation.result) {
      matches.add(claim.operation);
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

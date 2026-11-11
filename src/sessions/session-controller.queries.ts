import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ReplyRunAlreadyActiveError, type ReplyOperation } from "./session-controller.contracts.js";
import {
  activeSessionOperations,
  hasOperationBackendRunId,
  findSessionControllerEntries,
  getSessionControllerOperation,
  resolveReplyRunForCurrentSessionId,
  getSessionControllerEntryForOperation,
  hasReplyOperationExecutionStarted,
} from "./session-controller.state.js";
import { rpcSourcesByRunId } from "./session-controller.storage.js";
import type { SessionTarget } from "./session-controller.target.js";

export function isSessionRunActive(sessionId: string): boolean {
  return resolveReplyRunForCurrentSessionId(sessionId).kind !== "none";
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
  options?: { executionStartedOnly?: boolean },
): string | undefined {
  const operation = getSessionControllerOperation(sessionKey.trim(), target);
  return operation &&
    (!options?.executionStartedOnly || hasReplyOperationExecutionStarted(operation))
    ? operation.sessionId
    : undefined;
}

/** A logical key is busy even when it selects multiple physical owners. */
export function isSessionRunActiveForKey(sessionKey: string): boolean {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return Boolean(
    normalizedSessionKey &&
    findSessionControllerEntries(normalizedSessionKey).some((entry) => entry.active),
  );
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

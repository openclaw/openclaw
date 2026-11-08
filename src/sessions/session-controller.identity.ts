import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { diagnosticLogger as diag } from "../logging/diagnostic-runtime.js";
import type {
  ReplyOperation,
  SessionControllerInput,
  SessionControllerEntry,
} from "./session-controller.contracts.js";
import * as controllerStorage from "./session-controller.storage.js";

/** Reads logical identity from an exact reserved or adopted controller source. */
export function getSessionControllerSourceIdentity(input: SessionControllerInput): Readonly<{
  sessionId: string;
  sessionKey: string;
  agentId?: string;
}> {
  const operation = input.claim?.operation;
  return {
    sessionId: operation?.sessionId ?? input.sourceSessionId ?? input.target?.incarnation ?? "",
    sessionKey: operation?.key ?? input.target?.sessionKey ?? input.mailbox.key,
    agentId: operation?.agentId ?? input.target?.agentId,
  };
}

export function getSessionControllerEntryForOperation(
  operation: ReplyOperation,
): SessionControllerEntry {
  const entry = controllerStorage.controllerEntryByOperation.get(operation);
  if (!entry) {
    throw new Error("Operation has no controller owner");
  }
  return entry;
}
export function isCurrentSessionControllerOperation(operation: ReplyOperation): boolean {
  const entry = controllerStorage.controllerEntryByOperation.get(operation);
  return (
    entry !== undefined &&
    controllerStorage.sessionControllers.get(entry.id) === entry &&
    entry.active === operation
  );
}

export function assertSessionControllerOperation(operation: ReplyOperation): void {
  if (
    !isCurrentSessionControllerOperation(operation) ||
    operation.result ||
    operation.abortSignal.aborted
  ) {
    throw new Error("Session turn no longer owns controller admission");
  }
}

export type ReplyRunIdentityResolution =
  | { kind: "none" }
  | { kind: "one"; operation: ReplyOperation }
  | { kind: "ambiguous"; operations: ReplyOperation[] };

export function hasSessionControllerIdentity(sessionId: string): boolean {
  const id = normalizeOptionalString(sessionId);
  return Boolean(
    id &&
    [...controllerStorage.sessionControllers.values()].some(
      (entry) => entry.aliases.has(id) || entry.active?.hasOwnedSessionId(id) === true,
    ),
  );
}

/** Session IDs can overlap across stores or reused incarnations. Key lookup can
 * also overlap while logicalAliases, updateSessionKey moves, and updateSessionId
 * lineage retain old and new identities. */
export function resolveReplyRunForCurrentSessionId(sessionId: string): ReplyRunIdentityResolution {
  const id = normalizeOptionalString(sessionId);
  if (!id) {
    return { kind: "none" };
  }
  const matches = [...controllerStorage.sessionControllers.values()].filter(
    (entry) => entry.active?.hasOwnedSessionId(id) === true,
  );
  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length === 1) {
    return { kind: "one", operation: matches[0]!.active! };
  }
  diag.warn(
    `ambiguous session controller identity: sessionId=${id} entryIds=${matches
      .map((entry) => entry.id)
      .toSorted()
      .join(",")}`,
  );
  return { kind: "ambiguous", operations: matches.map((entry) => entry.active!) };
}

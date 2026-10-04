import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { SessionManagerCore } from "../../agents/sessions/session-manager-core.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptReadSnapshotSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { appendTranscriptMessageSnapshotSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import {
  assertCurrentSessionTranscriptHeader,
  findSessionTranscriptHeader,
} from "../../config/sessions/session-entry-codec.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

export type CommittedAgentMessage = Extract<
  AgentMessage,
  { role: "assistant" | "toolResult" | "user" }
> & { idempotencyKey: string };
type AppliedTranscriptMessage = {
  appended: boolean;
  message: AgentMessage;
  messageId: string;
  messageSeq?: number;
};
export type ApplyTranscriptCommitResult =
  | { ok: true; messages: AppliedTranscriptMessage[]; lifecycleRevision: string | undefined }
  | { ok: false; reason: "invalid-batch" | "session-not-attached" | "stale-base-leaf" };
type PersistedCommitResolution =
  | { kind: "ambiguous" | "missing" }
  | { kind: "found"; messages: AppliedTranscriptMessage[] };
export type TranscriptCommitInput = {
  scope: Omit<SessionTranscriptWriteScope, "env"> & SessionTranscriptRuntimeTarget;
  lifecycleRevision: string | undefined;
  requestedBaseLeafId: string | null;
  recoverPersistedBatch: boolean;
  messages: readonly CommittedAgentMessage[];
  cwd: string;
};
export type PreparedTranscriptCommit = {
  result: ApplyTranscriptCommitResult;
  version?: SessionTranscriptContextVersion;
  nextMessageSeq: number;
  parentId: string | null;
};

function readMessageIdempotencyKey(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const value = message.idempotencyKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isCommittedAgentMessage(message: unknown): message is CommittedAgentMessage {
  if (!isRecord(message)) {
    return false;
  }
  const role = message.role;
  return (
    (role === "user" || role === "assistant" || role === "toolResult") &&
    readMessageIdempotencyKey(message) !== undefined
  );
}

function resolveActiveCommitPrefix(params: {
  baseLeafId: string | null;
  manager: SessionManagerCore;
  messages: readonly AgentMessage[];
}):
  | {
      activeVisibleEntryCount: number;
      ok: true;
      recoveredMessages: AppliedTranscriptMessage[];
    }
  | { ok: false } {
  const activeBranch = params.manager.getBranch();
  const activeVisibleEntryCount = activeBranch.filter(
    (entry) => entry.type === "message" || entry.type === "compaction",
  ).length;
  if (params.manager.getLeafId() === params.baseLeafId) {
    return { activeVisibleEntryCount, ok: true, recoveredMessages: [] };
  }

  const baseIndex =
    params.baseLeafId === null
      ? -1
      : activeBranch.findIndex((entry) => entry.id === params.baseLeafId);
  if (params.baseLeafId !== null && baseIndex < 0) {
    return { ok: false };
  }

  const activeSuffix = activeBranch.slice(baseIndex + 1);
  if (activeSuffix.length === 0) {
    return { ok: false };
  }

  const recoveredMessages: AppliedTranscriptMessage[] = [];
  for (const [index, entry] of activeSuffix.slice(0, params.messages.length).entries()) {
    const expectedKey = readMessageIdempotencyKey(params.messages[index]);
    if (
      entry.type !== "message" ||
      !expectedKey ||
      !isCommittedAgentMessage(entry.message) ||
      readMessageIdempotencyKey(entry.message) !== expectedKey
    ) {
      return { ok: false };
    }
    recoveredMessages.push({
      appended: false,
      message: entry.message,
      messageId: entry.id,
    });
  }
  return { activeVisibleEntryCount, ok: true, recoveredMessages };
}

function resolvePersistedCommitAcrossDag(params: {
  baseLeafId: string | null;
  manager: SessionManagerCore;
  messages: readonly AgentMessage[];
}): PersistedCommitResolution {
  const childrenByParent = new Map<string | null, ReturnType<SessionManagerCore["getEntries"]>>();
  for (const entry of params.manager.getEntries()) {
    const children = childrenByParent.get(entry.parentId) ?? [];
    children.push(entry);
    childrenByParent.set(entry.parentId, children);
  }

  const completedPaths: AppliedTranscriptMessage[][] = [];
  const visit = (
    parentId: string | null,
    messageIndex: number,
    path: AppliedTranscriptMessage[],
  ): void => {
    if (completedPaths.length > 1) {
      return;
    }
    if (messageIndex === params.messages.length) {
      completedPaths.push(path);
      return;
    }
    const expectedKey = readMessageIdempotencyKey(params.messages[messageIndex]);
    if (!expectedKey) {
      return;
    }
    for (const entry of childrenByParent.get(parentId) ?? []) {
      if (
        entry.type !== "message" ||
        !isCommittedAgentMessage(entry.message) ||
        readMessageIdempotencyKey(entry.message) !== expectedKey
      ) {
        continue;
      }
      visit(entry.id, messageIndex + 1, [
        ...path,
        { appended: false, message: entry.message, messageId: entry.id },
      ]);
    }
  };

  // The pending ledger binds the request hash while each deterministic key
  // binds tuple + index. Do not compare re-redacted content across restarts.
  visit(params.baseLeafId, 0, []);
  if (completedPaths.length > 1) {
    return { kind: "ambiguous" };
  }
  const messages = completedPaths[0];
  return messages ? { kind: "found", messages } : { kind: "missing" };
}

export function prepareTranscriptCommit(input: TranscriptCommitInput): PreparedTranscriptCommit {
  const entry = loadSessionEntry(input.scope);
  if (!entry || entry.sessionId !== input.scope.sessionId) {
    return {
      result: { ok: false, reason: "session-not-attached" },
      parentId: null,
      nextMessageSeq: 0,
    };
  }
  if (
    input.lifecycleRevision !== undefined &&
    entry.lifecycleRevision !== input.lifecycleRevision
  ) {
    return { result: { ok: false, reason: "invalid-batch" }, parentId: null, nextMessageSeq: 0 };
  }
  const snapshot = loadTranscriptReadSnapshotSync(input.scope);
  if (snapshot.events.length > 0) {
    assertCurrentSessionTranscriptHeader(findSessionTranscriptHeader(snapshot.events));
  }
  const manager = new SessionManagerCore(input.cwd, undefined, snapshot.events);
  const plan = (
    result: ApplyTranscriptCommitResult,
    nextMessageSeq = 0,
  ): PreparedTranscriptCommit => ({
    result,
    version: snapshot.version,
    nextMessageSeq,
    parentId: manager.getAppendParentId(),
  });
  if (input.recoverPersistedBatch) {
    const recovered = resolvePersistedCommitAcrossDag({
      baseLeafId: input.requestedBaseLeafId,
      manager,
      messages: input.messages,
    });
    if (recovered.kind === "found") {
      return plan({
        ok: true,
        messages: recovered.messages,
        lifecycleRevision: entry.lifecycleRevision,
      });
    }
    if (recovered.kind === "ambiguous") {
      return plan({ ok: false, reason: "invalid-batch" });
    }
  }
  const prefix = resolveActiveCommitPrefix({
    baseLeafId: input.requestedBaseLeafId,
    manager,
    messages: input.messages,
  });
  return prefix.ok
    ? plan(
        {
          ok: true,
          messages: prefix.recoveredMessages,
          lifecycleRevision: entry.lifecycleRevision,
        },
        prefix.activeVisibleEntryCount,
      )
    : plan({ ok: false, reason: "stale-base-leaf" });
}

/** The caller owns one synchronous transaction around validation, append, and metadata. */
export function applyPreparedTranscriptCommit(
  input: TranscriptCommitInput,
  plan: PreparedTranscriptCommit,
  freshMessages: readonly CommittedAgentMessage[],
  onProjectionReconcileNeeded: () => void,
): ApplyTranscriptCommitResult {
  if (!plan.result.ok) {
    return plan.result;
  }
  const currentEntry = loadSessionEntry(input.scope);
  if (!currentEntry || currentEntry.sessionId !== input.scope.sessionId) {
    return { ok: false, reason: "session-not-attached" };
  }
  if (currentEntry.lifecycleRevision !== plan.result.lifecycleRevision) {
    return { ok: false, reason: "invalid-batch" };
  }
  const database = openOpenClawAgentDatabase(
    toDatabaseOptions(resolveSqliteTranscriptScope(input.scope)),
  );
  const version = readTranscriptContextVersionInTransaction(database, input.scope.sessionId);
  if (
    !plan.version ||
    version.generation !== plan.version.generation ||
    version.rawSeq !== plan.version.rawSeq ||
    version.updatedAt !== plan.version.updatedAt
  ) {
    return { ok: false, reason: "stale-base-leaf" };
  }
  if (plan.result.messages.length === input.messages.length) {
    return plan.result;
  }
  const recoveredCount = plan.result.messages.length;
  if (
    freshMessages.length !== input.messages.length - recoveredCount ||
    !freshMessages.every(
      (message, index) =>
        isCommittedAgentMessage(message) &&
        readMessageIdempotencyKey(message) ===
          readMessageIdempotencyKey(input.messages[recoveredCount + index]),
    )
  ) {
    return { ok: false, reason: "invalid-batch" };
  }
  const messages = [...plan.result.messages];
  let parentId = plan.parentId;
  let nextMessageSeq = plan.nextMessageSeq;
  for (const message of freshMessages) {
    const snapshot = appendTranscriptMessageSnapshotSync(
      input.scope,
      {
        message,
        cwd: input.cwd,
        parentId,
        appendIntent: "active-branch",
        idempotencyLookup: "caller-checked",
      },
      undefined,
      {
        messageAlreadyRedacted: true,
        scheduleProjectionReconcile: false,
        onProjectionReconcileNeeded,
      },
    );
    if (!snapshot.ok || !snapshot.value.result?.appended) {
      throw new Error("Worker transcript message was not persisted", {
        cause: snapshot.ok ? undefined : snapshot.error,
      });
    }
    const result = snapshot.value.result;
    parentId = result.messageId;
    nextMessageSeq += 1;
    messages.push({
      appended: true,
      message: result.message,
      messageId: result.messageId,
      messageSeq: nextMessageSeq,
    });
  }
  const entry = loadSessionEntry(input.scope);
  if (
    !entry ||
    entry.sessionId !== input.scope.sessionId ||
    entry.lifecycleRevision !== plan.result.lifecycleRevision
  ) {
    throw new Error("Worker transcript session changed inside its transaction");
  }
  replaceSessionEntrySync(input.scope, {
    ...entry,
    updatedAt: Math.max(entry.updatedAt ?? 0, Date.now()),
  });
  return { ...plan.result, messages };
}

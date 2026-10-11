import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { SessionManagerCore } from "../../agents/sessions/session-manager-core.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  assertCurrentSessionTranscriptHeader,
  findSessionTranscriptHeader,
} from "../../config/sessions/session-entry-codec.js";
import type { SessionTranscriptReadSnapshot } from "../../config/sessions/session-history-read.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { readTranscriptMessageIdempotencyKey } from "../session-transcript-entry-message.js";
import type {
  AppliedTranscriptMessage,
  ApplyTranscriptCommitResult,
  CommittedAgentMessage,
  TranscriptCommitInput,
} from "./transcript-commit.types.js";

type PersistedCommitResolution =
  | { kind: "ambiguous" | "missing" }
  | { kind: "found"; messages: AppliedTranscriptMessage[] };
export type PreparedTranscriptCommit = {
  result: ApplyTranscriptCommitResult;
  version?: SessionTranscriptContextVersion;
  nextMessageSeq: number;
  parentId: string | null;
};

export function isCommittedAgentMessage(message: unknown): message is CommittedAgentMessage {
  if (!isRecord(message)) {
    return false;
  }
  const role = message.role;
  return (
    (role === "user" ||
      role === "assistant" ||
      role === "toolResult" ||
      (role === "custom" &&
        (message.customType === "openclaw.runtime-context" ||
          message.customType === "openclaw.system-update"))) &&
    readTranscriptMessageIdempotencyKey(message) !== undefined
  );
}

function resolveActiveCommitPrefix(params: {
  baseLeafId: string | null;
  activeBranch: ReturnType<SessionManagerCore["getBranch"]>;
  activeLeafId: string | null;
  messages: readonly AgentMessage[];
}):
  | {
      ok: true;
      recoveredMessages: AppliedTranscriptMessage[];
    }
  | { ok: false } {
  const { activeBranch } = params;
  if (params.activeLeafId === params.baseLeafId) {
    return { ok: true, recoveredMessages: [] };
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
    const expectedKey = readTranscriptMessageIdempotencyKey(params.messages[index])?.trim();
    if (
      entry.type !== "message" ||
      !expectedKey ||
      !isCommittedAgentMessage(entry.message) ||
      readTranscriptMessageIdempotencyKey(entry.message)?.trim() !== expectedKey
    ) {
      return { ok: false };
    }
    recoveredMessages.push({
      appended: false,
      message: entry.message,
      messageId: entry.id,
    });
  }
  return { ok: true, recoveredMessages };
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
    const expectedKey = readTranscriptMessageIdempotencyKey(params.messages[messageIndex])?.trim();
    if (!expectedKey) {
      return;
    }
    for (const entry of childrenByParent.get(parentId) ?? []) {
      if (
        entry.type !== "message" ||
        !isCommittedAgentMessage(entry.message) ||
        readTranscriptMessageIdempotencyKey(entry.message)?.trim() !== expectedKey
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

export function prepareTranscriptCommitFromSnapshot(
  input: TranscriptCommitInput,
  entry: SessionEntry | undefined,
  readSnapshot: () => SessionTranscriptReadSnapshot,
): PreparedTranscriptCommit {
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
  const snapshot = readSnapshot();
  if (snapshot.events.length > 0) {
    assertCurrentSessionTranscriptHeader(findSessionTranscriptHeader(snapshot.events));
  }
  const manager = new SessionManagerCore(input.cwd, undefined, snapshot.events);
  const activeBranch = manager.getBranch();
  const activeVisibleEntries = activeBranch.filter(
    (event) => event.type === "message" || event.type === "compaction",
  );
  const plan = (
    result: ApplyTranscriptCommitResult,
    nextMessageSeq = 0,
  ): PreparedTranscriptCommit => {
    let applied = result;
    if (result.ok && result.messages.length > 0) {
      const activeSequences = new Map(
        activeVisibleEntries.map((event, index) => [event.id, index + 1]),
      );
      applied = {
        ...result,
        messages: result.messages.map((message) => {
          const messageSeq = activeSequences.get(message.messageId);
          return messageSeq === undefined ? message : { ...message, messageSeq };
        }),
      };
    }
    return {
      result: applied,
      version: snapshot.version,
      nextMessageSeq,
      parentId: manager.getAppendParentId(),
    };
  };
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
    activeBranch,
    activeLeafId: manager.getLeafId(),
    messages: input.messages,
  });
  return prefix.ok
    ? plan(
        {
          ok: true,
          messages: prefix.recoveredMessages,
          lifecycleRevision: entry.lifecycleRevision,
        },
        activeVisibleEntries.length,
      )
    : plan({ ok: false, reason: "stale-base-leaf" });
}

import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerTranscriptCommitParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import {
  loadSessionEntry,
  publishTranscriptUpdate,
  replaceSessionEntrySync,
  withTranscriptWriteTransaction,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  attachSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { prepareWorkerTurnTranscriptMessage } from "./placement-turn-claim-events.js";
import { resolveWorkerSessionTarget, type ResolvedWorkerSessionTarget } from "./session-target.js";
import type {
  WorkerTranscriptCommitInput,
  WorkerTranscriptCommitOutcome,
  WorkerTranscriptCommitStore,
} from "./transcript-commit-store.js";
import type {
  WorkerTranscriptCommitApplication,
  WorkerTranscriptCommitterOptions,
} from "./transcript-commit.js";

type SemanticAgentMessage = Extract<AgentMessage, { role: "assistant" | "toolResult" | "user" }>;
type CommittedAgentMessage = SemanticAgentMessage & { idempotencyKey: string };

type AppliedTranscriptMessage = {
  appended: boolean;
  message: AgentMessage;
  messageId: string;
  messageSeq?: number;
};

type ApplyTranscriptCommitResult =
  | { ok: true; messages: AppliedTranscriptMessage[] }
  | { ok: false; reason: "invalid-batch" | "session-not-attached" | "stale-base-leaf" };

type PersistedCommitResolution =
  | { kind: "ambiguous" | "missing" }
  | { kind: "found"; messages: AppliedTranscriptMessage[] };

const WORKER_TRANSCRIPT_SESSION_CONFLICT = new Error("worker transcript session changed");

function requestHash(request: WorkerTranscriptCommitParams): string {
  return createHash("sha256")
    .update(
      stableStringify({
        baseLeafId: request.baseLeafId,
        messages: request.messages,
      }),
    )
    .digest("hex");
}

function messageIdempotencyKey(params: {
  sessionId: string;
  runEpoch: number;
  seq: number;
  index: number;
}): string {
  const digest = createHash("sha256")
    .update([params.sessionId, params.runEpoch, params.seq, params.index].join("\0"))
    .digest("base64url");
  return `worker-commit-${digest}`;
}

function readMessageIdempotencyKey(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const value = message.idempotencyKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isCommittedAgentMessage(message: unknown): message is CommittedAgentMessage {
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
  manager: SessionManager;
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
  manager: SessionManager;
  messages: readonly AgentMessage[];
}): PersistedCommitResolution {
  const childrenByParent = new Map<string | null, ReturnType<SessionManager["getEntries"]>>();
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

async function applyWorkerTranscriptCommit(params: {
  assertCurrent: () => undefined;
  config: OpenClawConfig;
  identity: WorkerConnectionIdentity;
  messages: readonly CommittedAgentMessage[];
  recoverPersistedBatch: boolean;
  requestedBaseLeafId: string | null;
  runId: string | null;
  sessionId: string;
  target: ResolvedWorkerSessionTarget;
}): Promise<ApplyTranscriptCommitResult> {
  const redactedMessages = params.messages.map((message) =>
    attachSessionTranscriptRunId(redactTranscriptMessage(message, params.config), params.runId),
  );
  const expectedState = {
    sessionId: params.sessionId,
    lifecycleRevision: params.target.sessionEntry.lifecycleRevision,
  };
  let applied: ApplyTranscriptCommitResult;
  try {
    applied = await withTranscriptWriteTransaction(params.target, (transcriptTarget) => {
      params.assertCurrent();
      const currentEntry = loadSessionEntry(params.target);
      if (!currentEntry || currentEntry.sessionId !== expectedState.sessionId) {
        return { ok: false as const, reason: "session-not-attached" as const };
      }
      if (currentEntry.lifecycleRevision !== expectedState.lifecycleRevision) {
        return { ok: false as const, reason: "invalid-batch" as const };
      }

      const manager = SessionManager.open(transcriptTarget);
      if (params.recoverPersistedBatch) {
        // Only a pending ledger row may prove an off-branch batch: the agent DB
        // can commit before the shared replay ledger records its terminal result.
        const recovered = resolvePersistedCommitAcrossDag({
          baseLeafId: params.requestedBaseLeafId,
          manager,
          messages: params.messages,
        });
        if (recovered.kind === "found") {
          return { ok: true as const, messages: recovered.messages };
        }
        if (recovered.kind === "ambiguous") {
          return { ok: false as const, reason: "invalid-batch" as const };
        }
      }
      const prefix = resolveActiveCommitPrefix({
        baseLeafId: params.requestedBaseLeafId,
        manager,
        messages: params.messages,
      });
      if (!prefix.ok) {
        return { ok: false as const, reason: "stale-base-leaf" as const };
      }

      // Redaction can change role discriminators; admit the whole fresh suffix before any writes.
      const freshMessages = redactedMessages.slice(prefix.recoveredMessages.length);
      if (!freshMessages.every(isCommittedAgentMessage)) {
        return { ok: false as const, reason: "invalid-batch" as const };
      }

      const messages = [...prefix.recoveredMessages];
      let nextMessageSeq = prefix.activeVisibleEntryCount;
      for (const message of freshMessages) {
        if (message.role === "assistant") {
          Object.assign(message, prepareWorkerTurnTranscriptMessage(params.identity, message));
        }
        const messageId = manager.appendMessage(message, {
          config: params.config,
          // Active-path recovery owns dedupe. A global key scan could reuse an
          // id from an abandoned branch while SessionManager advances another id.
          idempotencyLookup: "caller-checked",
        });
        nextMessageSeq += 1;
        messages.push({
          appended: true,
          message,
          messageId,
          messageSeq: nextMessageSeq,
        });
      }

      const freshEntry = loadSessionEntry(params.target);
      if (
        !freshEntry ||
        freshEntry.sessionId !== expectedState.sessionId ||
        freshEntry.lifecycleRevision !== expectedState.lifecycleRevision
      ) {
        throw WORKER_TRANSCRIPT_SESSION_CONFLICT;
      }
      const appendedCount = messages.filter((message) => message.appended).length;
      const nextEntry = {
        ...freshEntry,
        ...(appendedCount > 0
          ? { updatedAt: Math.max(freshEntry.updatedAt ?? 0, Date.now()) }
          : {}),
      };
      replaceSessionEntrySync(params.target, nextEntry);
      // Synchronous assistant preparation can close the owner after earlier rows were appended.
      params.assertCurrent();
      return { ok: true as const, messages };
    });
  } catch (error) {
    if (error === WORKER_TRANSCRIPT_SESSION_CONFLICT) {
      return { ok: false, reason: "invalid-batch" };
    }
    throw error;
  }
  if (!applied.ok) {
    return applied;
  }

  for (const message of applied.messages) {
    if (!message.appended) {
      continue;
    }
    const runId = resolveTerminalAssistantTranscriptRunId(message.message, params.runId);
    await publishTranscriptUpdate(params.target, {
      lifecycleRevision: expectedState.lifecycleRevision,
      message: message.message,
      messageId: message.messageId,
      messageSeq: message.messageSeq,
      ...(runId ? { runId } : {}),
    });
  }
  return applied;
}

export async function commitWorkerTranscript(
  options: WorkerTranscriptCommitterOptions,
  store: WorkerTranscriptCommitStore,
  sessionId: string,
  params: Parameters<WorkerTranscriptCommitApplication>[0],
): Promise<WorkerTranscriptCommitOutcome> {
  const input: WorkerTranscriptCommitInput = {
    environmentId: params.identity.environmentId,
    sessionId,
    runEpoch: params.request.runEpoch,
    seq: params.request.seq,
    requestHash: requestHash(params.request),
  };
  params.assertCurrent();
  const started = store.begin(input);
  if (started.kind === "replay") {
    return started.outcome;
  }
  if (started.kind === "rejected") {
    return { ok: false, reason: "invalid-batch" };
  }

  const config = options.getConfig();
  const target = resolveWorkerSessionTarget(config, sessionId);
  if (!target) {
    return store.complete({
      ...input,
      outcome: { ok: false, reason: "session-not-attached" },
    });
  }
  // Ingress validated the closed schema; clone every admitted field before transcript redaction.
  const messages = params.request.messages.map((message, index) => ({
    ...structuredClone(message),
    idempotencyKey: messageIdempotencyKey({
      sessionId,
      runEpoch: params.request.runEpoch,
      seq: params.request.seq,
      index,
    }),
  }));
  let authorityFailure: { error: unknown } | undefined;
  let applied: ApplyTranscriptCommitResult;
  try {
    applied = await applyWorkerTranscriptCommit({
      assertCurrent: () => {
        try {
          params.assertCurrent();
        } catch (error) {
          authorityFailure = { error };
          throw error;
        }
      },
      config,
      identity: params.identity,
      messages,
      recoverPersistedBatch: started.kind === "recover",
      requestedBaseLeafId: params.request.baseLeafId,
      runId: params.identity.runId,
      sessionId,
      target,
    });
  } catch (error) {
    // A callback refusal has rolled back the agent transaction. Free only
    // this invocation's fresh reservation; unknown commit outcomes must recover.
    if (started.kind === "claimed" && authorityFailure && authorityFailure.error === error) {
      store.discardUncommitted(input);
    }
    throw error;
  }
  if (!applied.ok) {
    return store.complete({ ...input, outcome: { ok: false, reason: applied.reason } });
  }
  const entryIds = applied.messages.map((message) => message.messageId);
  const newLeafId = entryIds.at(-1);
  if (entryIds.length !== params.request.messages.length || !newLeafId) {
    return store.complete({
      ...input,
      outcome: { ok: false, reason: "invalid-batch" },
    });
  }
  return store.complete({
    ...input,
    outcome: { ok: true, result: { entryIds, newLeafId } },
  });
}

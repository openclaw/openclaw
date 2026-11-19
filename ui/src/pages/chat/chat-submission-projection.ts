import type {
  SessionMessageIdentity,
  SessionProjectionScope,
} from "@openclaw/gateway-client/browser";
import {
  type ApplicationChatSubmissions,
  type RetainedChatSubmission,
  retireInitialChatSubmission,
} from "../../app/chat-submissions.ts";
import { chatOutboxDeliveryKey, type ChatComposerScope } from "../../lib/chat/outbox-store.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";

export function isInitialSubmissionReceipt(
  submission: RetainedChatSubmission | null | undefined,
  identity: SessionMessageIdentity | null,
): boolean {
  return (
    submission?.kind === "initial" &&
    identity?.role === "user" &&
    !identity.isImported &&
    (identity.id !== null || identity.sequence !== null) &&
    (identity.idempotencyKey === submission.pendingRunId ||
      identity.idempotencyKey === `${submission.pendingRunId}:user`)
  );
}

export function readChatSubmissionBatch(
  owner: ChatComposerScope & { sessionKey: string; chatSubmissions?: ApplicationChatSubmissions },
  scope: SessionProjectionScope,
) {
  const submissions = owner.chatSubmissions;
  if (!submissions) {
    return undefined;
  }
  const sessionKey = scope.sessionKey ?? owner.sessionKey;
  const client = owner.client;
  const handoff = submissions.readInitial(sessionKey, client ?? null, scope.sessionId);
  // The pane captures one client and delivery key for the synchronous receipt batch.
  const key = chatOutboxDeliveryKey(owner, {
    sessionKey,
    agentId: scope.agentId ?? resolveUiSelectedSessionAgentId(owner),
  });
  const deliveredInScope = (runId: string) => {
    const entry = submissions.readDelivered(key + runId, client ?? owner);
    return entry?.kind === "delivered" &&
      (!entry.sessionId || !scope.sessionId || entry.sessionId === scope.sessionId)
      ? entry
      : undefined;
  };
  const retire = (runId: string, awaitTranscriptReceipt = false) => {
    const entry = deliveredInScope(runId);
    if (entry && !(awaitTranscriptReceipt && persistedSteerTargetRunId(entry.message))) {
      entry.pending = false;
    }
  };
  return {
    initial: handoff,
    accept: (runIds: ReadonlySet<string>, awaitTranscriptReceipt = false) => {
      runIds.forEach((runId) => retire(runId, awaitTranscriptReceipt));
      if (handoff && runIds.has(handoff.pendingRunId)) {
        retireInitialChatSubmission(handoff);
      }
    },
    ownsPendingSteer: (identity: SessionMessageIdentity | null) => {
      const runId = identity?.idempotencyKey?.replace(/:user$/u, "");
      const entry = runId ? deliveredInScope(runId) : undefined;
      return Boolean(
        identity?.role === "user" &&
        !identity.isImported &&
        identity.id === null &&
        identity.sequence === null &&
        entry?.pending &&
        persistedSteerTargetRunId(entry.message),
      );
    },
    receive: (message: unknown, identity: SessionMessageIdentity | null, persisted = false) => {
      const runId = identity?.idempotencyKey?.replace(/:user$/u, "");
      if (handoff && isInitialSubmissionReceipt(handoff, identity)) {
        if (runId) {
          retire(runId);
        }
        retireInitialChatSubmission(handoff);
        return message;
      }
      if (identity?.role !== "user" || !runId) {
        return message;
      }
      const receipt = persisted || identity.id !== null || identity.sequence !== null;
      if (receipt) {
        retire(runId);
      }
      const delivered = deliveredInScope(runId);
      if (!receipt && !identity.isImported && delivered && !delivered.pending) {
        return undefined;
      }
      if (!handoff || identity.isImported || runId !== handoff.pendingRunId) {
        return message;
      }
      // Cached bytes for this retained submission are not a receipt. Omit
      // that snapshot copy; the pane admits the recorded local owner through
      // sendPending, preserving provenance even with sender/reply metadata.
      if (!receipt) {
        return undefined;
      }
      retireInitialChatSubmission(handoff);
      return message;
    },
  };
}

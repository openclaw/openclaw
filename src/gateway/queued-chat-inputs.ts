import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readMessageClientSources } from "../chat/message-client-source.js";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import type { SessionPendingInputEndCause } from "../config/sessions/session-pending-input-end-cause.types.js";
import { readSessionQueuedInputPage } from "../config/sessions/session-pending-input-history.js";
import { preparePendingInputStore } from "../config/sessions/session-pending-input-store.js";
import { parseSessionPendingInputMessage } from "../config/sessions/session-pending-input-value.js";
import type { SessionPendingInputRow } from "../config/sessions/session-pending-input.types.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { MEDIA_ONLY_USER_TEXT } from "../sessions/user-turn-media.js";
import { resolvePendingInputEndCause } from "../sessions/user-turn-transcript-processing.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { getResidentUserProfileDisplay } from "../state/user-profile-list.js";
import { isBrowserCopilotClient } from "../utils/message-channel.js";
import { decodeQueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import { queuedChatInputAdmission } from "./queued-chat-input-admission.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

type Target = { agentId: string; storePath: string; sessionKey: string; sessionId: string };

async function failQueuedInput(
  target: Target,
  row: SessionPendingInputRow,
  assertCurrent: () => void,
  endCause: SessionPendingInputEndCause,
) {
  const store = await preparePendingInputStore(target, assertCurrent);
  try {
    await store.mutate(
      {
        kind: "finish",
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
        idempotencyKey: row.idempotency_key,
        runId: row.run_id,
        requestHash: row.request_hash,
        lifecycleGeneration: row.lifecycle_generation,
        inputId: row.input_id,
        disposition: "cancelled",
        endCause,
      },
      assertCurrent,
    );
  } finally {
    await store.release();
  }
}

type QueuedInputReplayFailure = { error: unknown };
type DeferredQueuedInputReplay = QueuedInputReplayFailure & { resume: () => Promise<void> };

/** Re-admit durable FIFO rows; only a committed transcript append consumes them. */
export async function continueSessionQueuedInputs(
  context: GatewayRequestContext,
  target: Target,
  options: {
    signal: AbortSignal;
    assertCurrent: () => void;
    /** Ends every row with this cause instead of replaying it. */
    endCause?: SessionPendingInputEndCause;
  },
): Promise<DeferredQueuedInputReplay | undefined> {
  const assertCurrent = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  const admit = async (row: SessionPendingInputRow) => {
    assertCurrent();
    if (options.endCause) {
      await failQueuedInput(target, row, assertCurrent, options.endCause);
      return undefined;
    }
    let admitted: Awaited<ReturnType<typeof restoreGatewayQueuedOperatorRecovery>> | undefined;
    let dispatchAttempted = false;
    try {
      const message = parseSessionPendingInputMessage(row.message_json);
      if (message["__openclaw"]?.activeSteer) {
        // Native delivery may have succeeded before a crash. Never replay into any run.
        await failQueuedInput(target, row, assertCurrent, "restart-unrecoverable");
        return undefined;
      }
      const sender = readTranscriptSenderIdentity(message["__openclaw"]?.senderIdentity);
      // A paired browser's process-local tab/profile capability cannot survive restart.
      if (readMessageClientSources(message).some(isBrowserCopilotClient)) {
        throw new Error("Browser-bound queued input requires a fresh browser send");
      }
      if (sender?.type !== "profile") {
        throw new Error("Queued input sender has no current human principal");
      }
      if (!row.origin_source_json) {
        throw new Error("Queued input has no original operator source; submit a new request.");
      }
      admitted = await restoreGatewayQueuedOperatorRecovery({
        context,
        source: decodeQueuedOperatorRecoverySource(JSON.parse(row.origin_source_json)),
        assertCurrent,
      });
      const { authority } = admitted;
      authority.assertCurrent();
      if (authority.profileId !== sender.id) {
        throw new Error("Queued input operator source does not match its sender.");
      }
      const profile = getResidentUserProfileDisplay(authority.profileId);
      const client = createSyntheticPluginRuntimeClient({
        authenticatedUserProfile: admitted.authenticatedUserProfile,
        operatorRoleActor: { kind: "operator", profileId: authority.profileId },
        operatorRunAuthority: authority,
        scopes: [...authority.scopes],
      });
      let execution: Promise<void> | undefined;
      try {
        dispatchAttempted = true;
        await queuedChatInputAdmission.run(
          {
            target: {
              ...target,
              inputId: row.input_id,
              runId: row.run_id,
              message,
              requestHash: row.request_hash,
            },
            requestFingerprint: row.request_hash.startsWith("request:")
              ? row.request_hash.slice(8)
              : row.request_hash,
            requesterProfile: {
              id: authority.profileId,
              displayName: profile.displayName,
              isCurrent: () => {
                try {
                  authority.assertCurrent();
                  return true;
                } catch {
                  return false;
                }
              },
            },
          },
          () =>
            dispatchGatewayRequestInProcess(
              "chat.send",
              {
                agentId: target.agentId,
                sessionKey: target.sessionKey,
                sessionId: target.sessionId,
                idempotencyKey: row.run_id,
                deliver: message["__openclaw"]?.chatSendDelivery?.deliver,
                originatingChannel: message["__openclaw"]?.chatSendDelivery?.originatingChannel,
                originatingTo: message["__openclaw"]?.chatSendDelivery?.originatingTo,
                originatingAccountId: message["__openclaw"]?.chatSendDelivery?.originatingAccountId,
                originatingThreadId: message["__openclaw"]?.chatSendDelivery?.originatingThreadId,
                thinking: message["__openclaw"]?.chatSendRuntime?.thinking,
                fastMode: message["__openclaw"]?.chatSendRuntime?.fastMode,
                fastAutoOnSeconds: message["__openclaw"]?.chatSendRuntime?.fastAutoOnSeconds,
                timeoutMs: message["__openclaw"]?.chatSendRuntime?.timeoutMs,
                replyToId: normalizeOptionalString(message["__openclaw"]?.replyToId),
                message:
                  extractTextFromChatContent(message.content, { joinWith: "\n" }) ||
                  MEDIA_ONLY_USER_TEXT,
                ...(message["__openclaw"]?.suppressCommandInterpretation === true
                  ? { suppressCommandInterpretation: true }
                  : {}),
                queueMode: "followup",
              },
              {
                context,
                client,
                signal: options.signal,
                onExecution: (pending) => {
                  execution = pending;
                },
                assertPreparationCurrent: authority.assertCurrent,
                sessionMutationCommitGuard: authority.assertCurrent,
                hasCurrentClientAuthority: () => {
                  authority.assertCurrent();
                  return true;
                },
              },
            ),
        );
      } finally {
        const release = admitted.release;
        if (execution) {
          void execution.then(release, release);
          admitted = undefined;
        }
      }
    } catch (error) {
      assertCurrent();
      // Before dispatch, an unclassified failure means the stored source cannot be restored.
      const endCause = resolvePendingInputEndCause(
        undefined,
        error,
        dispatchAttempted ? "failed" : "restart-unrecoverable",
      );
      if (endCause === undefined) {
        context.logGateway.warn(
          `Queued input ${row.run_id} is waiting for restart authority: ${String(error)}`,
        );
        return { error };
      }
      context.logGateway.warn(
        `Queued input ${row.run_id} was not sent after restart: ${String(error)}`,
      );
      await failQueuedInput(target, row, assertCurrent, endCause);
    } finally {
      admitted?.release();
    }
    return undefined;
  };
  // History pages are bounded newest-first; admit the older page before this one.
  const continuePage = async (before?: number): Promise<QueuedInputReplayFailure | undefined> => {
    assertCurrent();
    const page = await readSessionQueuedInputPage(target, {
      before,
    });
    if (page.nextBefore !== undefined) {
      const deferred = await continuePage(page.nextBefore);
      if (deferred) {
        return deferred;
      }
    }
    for (const row of page.rows.toReversed()) {
      const deferred = await admit(row);
      if (deferred) {
        return deferred;
      }
    }
    return undefined;
  };
  const deferred = await continuePage();
  if (!deferred) {
    return undefined;
  }
  let flight: Promise<void> | undefined;
  return {
    error: deferred.error,
    resume: () => {
      flight ??= runWithGatewayIndependentRootWorkAdmission(
        () =>
          withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, async () => {
            const remaining = await continuePage();
            if (remaining) {
              throw remaining.error;
            }
          }),
        "startup:queued-input-resume",
        options.signal,
      ).finally(() => {
        flight = undefined;
      });
      return flight;
    },
  };
}

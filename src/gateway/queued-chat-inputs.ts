import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import { readSessionQueuedInputPage } from "../config/sessions/session-pending-input-history.js";
import { preparePendingInputStore } from "../config/sessions/session-pending-input-store.js";
import { parseSessionPendingInputMessage } from "../config/sessions/session-pending-input-value.js";
import type { SessionPendingInputRow } from "../config/sessions/session-pending-input.types.js";
import { MEDIA_ONLY_USER_TEXT } from "../sessions/user-turn-media.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { getResidentUserProfileDisplay } from "../state/user-profile-list.js";
import { queuedChatInputAdmission } from "./queued-chat-input-admission.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";

type Target = { agentId: string; storePath: string; sessionKey: string; sessionId: string };

async function failQueuedInput(
  target: Target,
  row: SessionPendingInputRow,
  assertCurrent: () => void,
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
      },
      assertCurrent,
    );
  } finally {
    await store.release();
  }
}

/** Continue only accepted FIFO inputs belonging to an explicitly marked graceful shutdown. */
export async function continueSessionQueuedInputs(
  context: GatewayRequestContext,
  target: Target,
  options: {
    signal: AbortSignal;
    assertCurrent: () => void;
    queuedInputIds: readonly string[];
  },
): Promise<void> {
  const assertCurrent = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  const admit = async (row: SessionPendingInputRow) => {
    assertCurrent();
    const message = parseSessionPendingInputMessage(row.message_json);
    const sender = readTranscriptSenderIdentity(message["__openclaw"]?.senderIdentity);
    let admitted: Awaited<ReturnType<typeof prepareSessionPrincipalRunAuthority>> | undefined;
    try {
      if (sender?.type !== "profile") {
        throw new Error("Queued input sender has no current human principal");
      }
      admitted = await prepareSessionPrincipalRunAuthority({
        context,
        ...target,
        profileId: sender.id,
        assertCurrent,
      });
      const { authority } = admitted;
      authority.assertCurrent();
      const profile = getResidentUserProfileDisplay(authority.profileId);
      const client = createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "operator", profileId: authority.profileId },
        operatorRunAuthority: authority,
        scopes: [...authority.scopes],
      });
      let execution: Promise<void> | undefined;
      try {
        await queuedChatInputAdmission.run(
          {
            target: { ...target, runId: row.run_id, message, requestHash: row.request_hash },
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
      context.logGateway.warn(
        `Queued input ${row.run_id} was not sent after restart: ${String(error)}`,
      );
      await failQueuedInput(target, row, assertCurrent);
    } finally {
      admitted?.release();
    }
  };
  // History pages are bounded newest-first; admit the older page before this one.
  const continuePage = async (before?: number): Promise<void> => {
    assertCurrent();
    const page = await readSessionQueuedInputPage(target, {
      before,
      queuedInputIds: options.queuedInputIds,
    });
    if (page.nextBefore !== undefined) {
      await continuePage(page.nextBefore);
    }
    for (const row of page.rows.toReversed()) {
      await admit(row);
    }
  };
  await continuePage();
}

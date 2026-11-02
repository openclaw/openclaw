import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type HumanMention,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import type { SessionTranscriptTurnPersistOptions } from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import {
  projectChatDisplayMessage,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { findCanonicalStoreMatch } from "../session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { loadIncognitoGatewaySessionEntryReadOnly } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  resolveGlobalAwareNodeChatDeliveryKeys,
  sendGlobalAwareNodeChatPayload,
} from "./chat-broadcast.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import type { GatewayRequestContext } from "./types.js";

export type GatewayAssistantInjection = {
  sessionKey: string;
  agentId?: string;
  message: string;
  label?: string;
  idempotencyKey?: string;
  humanMentions?: readonly HumanMention[];
  /** Keep host-authored text as written instead of parsing model delivery directives. */
  literal?: true;
  onMessageCommitted?: SessionTranscriptTurnPersistOptions["onMessageCommitted"];
};

export type GatewayAssistantInjectionContext = Pick<
  GatewayRequestContext,
  "getRuntimeConfig" | "broadcast" | "nodeSendToSession"
>;

/** Append and publish one Gateway-authored assistant message in an existing session. */
export async function injectGatewayAssistantMessage(
  context: GatewayAssistantInjectionContext,
  params: GatewayAssistantInjection,
  sessionMutationCommitGuard?: () => void,
): Promise<Result<{ messageId: string; replayed?: true }, ErrorShape>> {
  const rawSessionKey = params.sessionKey;
  const agentIdOverride = normalizeOptionalString(params.agentId);
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedSessionAgentId(cfg, rawSessionKey, agentIdOverride);
  if (!requestedAgent.ok) {
    return err(requestedAgent.error);
  }
  const sessionLoadOptions = { agentId: requestedAgent.agentId };
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  const {
    agentId,
    storePath,
    entry,
    canonicalKey: sessionKey,
  } = isIncognitoSessionKey(rawSessionKey)
    ? loadIncognitoGatewaySessionEntryReadOnly(rawSessionKey, sessionLoadOptions, cfg)
    : await loadGatewaySessionEntryReadOnlyInWorker({
        excludeInternalEffects: true,
        cfg,
        key: rawSessionKey,
        ...sessionLoadOptions,
        onSelected: (target) => {
          retained?.release();
          const selected = findCanonicalStoreMatch(target.store, target.storeKeys)?.entry;
          if (typeof target.capturedReadSource?.databaseIdentity === "string") {
            retained = retainPreparedSessionEntryPredicate({
              databaseIdentity: `file:${target.capturedReadSource.databaseIdentity}`,
              sessionKey: target.canonicalKey,
              entry: selected,
              matches: (_before, after) => after?.sessionId === selected?.sessionId,
            });
          }
        },
      }).catch((error: unknown) => {
        retained?.release();
        throw error;
      });
  const sessionId = entry?.sessionId;
  if (!sessionId || !storePath) {
    retained?.release();
    return err(errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
  }

  let appended: Awaited<ReturnType<typeof appendInjectedAssistantMessageToTranscript>>;
  try {
    const admission = await beginSessionEffect({
      agentId,
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey,
        agentId,
        incarnation: sessionId,
      }),
      storeWriterIdentities: [sessionKey],
      assertAllowed: () => {
        sessionMutationCommitGuard?.();
        const current = retained?.readCurrent();
        if (retained && !current) {
          throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
        }
        const latestEntry = isIncognitoSessionKey(sessionKey)
          ? loadIncognitoGatewaySessionEntryReadOnly(rawSessionKey, sessionLoadOptions).entry
          : (current?.entry ?? entry);
        if (latestEntry?.sessionId !== sessionId) {
          throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
        }
        const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry);
        if (archivedError) {
          throw new Error(archivedError);
        }
      },
    });
    try {
      appended = await admission.run(async () => {
        sessionMutationCommitGuard?.();
        return await appendInjectedAssistantMessageToTranscript({
          sessionKey,
          message: params.message,
          label: params.label,
          idempotencyKey: params.idempotencyKey,
          humanMentions: params.humanMentions,
          ...(params.literal ? { literal: true as const } : {}),
          // Authority can end while the write waits for its target or queue.
          ...(sessionMutationCommitGuard ? { assertCurrent: sessionMutationCommitGuard } : {}),
          onMessageCommitted: params.onMessageCommitted,
          sessionId,
          storePath,
          agentId,
          config: cfg,
        });
      });
    } finally {
      admission.release();
    }
  } catch (error) {
    return err(errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(error)));
  } finally {
    retained?.release();
  }
  if (!appended.ok || !appended.messageId || !appended.message) {
    return err(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `failed to write transcript: ${appended.error ?? "unknown error"}`,
      ),
    );
  }
  if (appended.replayed) {
    // The original append already published this message.
    return ok({ messageId: appended.messageId, replayed: true });
  }

  const message = projectChatDisplayMessage(appended.message, {
    maxChars: resolveEffectiveChatHistoryMaxChars(),
  });
  const chatPayload = {
    runId: `inject-${appended.messageId}`,
    sessionKey,
    ...(agentId ? { agentId } : {}),
    seq: 0,
    state: "final" as const,
    message,
  };
  context.broadcast("chat", chatPayload, {
    sessionKeys: resolveGlobalAwareNodeChatDeliveryKeys({ cfg, sessionKey, agentId }),
  });
  sendGlobalAwareNodeChatPayload({
    context,
    sessionKey,
    agentId,
    event: "chat",
    payload: chatPayload,
  });

  return ok({ messageId: appended.messageId });
}

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatInjectParams,
  validateChatToolTitlesParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionActor,
} from "../../config/sessions/session-incognito-binding.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  projectChatDisplayMessage,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  resolveGlobalAwareNodeChatDeliveryKeys,
  sendGlobalAwareNodeChatPayload,
} from "./chat-broadcast.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const chatHandlers: GatewayRequestHandlers = {
  ...chatHistoryHandlers,
  ...chatMessageGetHandlers,
  "chat.toolTitles": async ({ params, respond }) => {
    if (!assertValidParams(params, validateChatToolTitlesParams, "chat.toolTitles", respond)) {
      return;
    }
    // Keep the shipped disabled response until a versioned protocol removal;
    // older clients stop asking, while current clients read the tool call title.
    respond(true, { titles: {}, disabled: true });
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateChatInjectParams, "chat.inject", respond)) {
      return;
    }
    const rawSessionKey = params.sessionKey;
    const agentIdOverride = normalizeOptionalString(params.agentId);
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, rawSessionKey, agentIdOverride);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const sessionLoadOptions = { agentId: requestedAgent.agentId };
    const source = captureIncognitoSessionSource({
      ...sessionLoadOptions,
      sessionKey: rawSessionKey,
    });
    const inject = async (
      session: ReturnType<typeof loadSessionEntry>,
      assertSourceCurrent: () => void = () => {},
    ) => {
      const { agentId, storePath, entry, canonicalKey: sessionKey } = session;
      const sessionId = entry?.sessionId;
      if (!sessionId || !storePath) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
        return;
      }

      let appended: Awaited<ReturnType<typeof appendInjectedAssistantMessageToTranscript>>;
      try {
        const admission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey, sessionId],
          assertAllowed: () => {
            assertSourceCurrent();
            source?.admissionSignal?.throwIfAborted();
            const latestEntry = source
              ? "kind" in source
                ? undefined
                : source.actor.sessions.readSharing(sessionKey)?.entry
              : loadSessionEntry(rawSessionKey, sessionLoadOptions).entry;
            if (!latestEntry) {
              throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
            }
            if (latestEntry.sessionId !== sessionId) {
              throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
            }
            const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry);
            if (archivedError) {
              throw new Error(archivedError);
            }
          },
        });
        try {
          appended = await admission.run(
            async () =>
              await appendInjectedAssistantMessageToTranscript({
                sessionKey,
                message: params.message,
                label: params.label,
                sessionId,
                storePath,
                agentId,
                config: cfg,
              }),
          );
        } finally {
          admission.release();
        }
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
      if (!appended.ok || !appended.messageId || !appended.message) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to write transcript: ${appended.error ?? "unknown error"}`,
          ),
        );
        return;
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
      assertSourceCurrent();
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

      assertSourceCurrent();
      respond(true, { ok: true, messageId: appended.messageId });
    };
    if (!source) {
      await inject(loadSessionEntry(rawSessionKey, sessionLoadOptions, cfg));
      return;
    }
    const useSource = async () => {
      const session = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg,
        key: rawSessionKey,
        ...sessionLoadOptions,
      });
      const claim =
        "kind" in source ? undefined : source.actor.sessions.captureCurrent(session.canonicalKey);
      await inject(session, () => {
        source.admissionSignal?.throwIfAborted();
        if ("kind" in source) {
          source.assertCurrent();
        } else {
          claim?.assertCurrent();
        }
      });
    };
    if ("kind" in source) {
      await useSource();
    } else {
      await withIncognitoSessionActor(source.actor, useSource, source.admissionSignal);
    }
  },
};

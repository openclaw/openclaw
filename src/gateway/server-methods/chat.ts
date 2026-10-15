import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatInjectParams,
  validateChatToolTitlesParams,
  type ChatInjectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
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
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { chatPredictionHandlers } from "./chat-prediction-handler.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const chatHandlers: GatewayRequestHandlers = {
  ...chatHistoryHandlers,
  ...chatMessageGetHandlers,
  ...chatPredictionHandlers,
  "chat.toolTitles": async ({ params, respond }) => {
    if (!assertValidParams(params, validateChatToolTitlesParams, "chat.toolTitles", respond)) {
      return;
    }
    // Keep the shipped disabled response until a versioned protocol removal;
    // older clients stop asking, while current clients read the tool call title.
    respond(true, { titles: {}, disabled: true });
  },
  "chat.inject": async (options) => {
    const { params, respond, sessionMutationCommitGuard } = options;
    if (!assertValidParams(params, validateChatInjectParams, "chat.inject", respond)) {
      return;
    }
    if (!isIncognitoSessionKey(params.sessionKey)) {
      return injectChat(options, params);
    }
    const assertCurrent = () => sessionMutationCommitGuard?.();
    const binding = await acquireSessionActorStorage(
      { sessionKey: params.sessionKey, agentId: normalizeOptionalString(params.agentId) },
      {
        lifetime: { assertCurrent, assertReadable: assertCurrent },
        authority: { assertCurrent, authorize: assertCurrent },
      },
    );
    if (!binding) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }
    try {
      await runWithSessionActorStorage(binding, () => injectChat(options, params));
    } finally {
      await binding.actor.release();
    }
  },
};

async function injectChat(
  { respond, context, sessionMutationCommitGuard }: GatewayRequestHandlerOptions,
  params: ChatInjectParams,
): Promise<void> {
  const rawSessionKey = params.sessionKey;
  const agentIdOverride = normalizeOptionalString(params.agentId);
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedSessionAgentId(cfg, rawSessionKey, agentIdOverride);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
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
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
    return;
  }

  let appended: Awaited<ReturnType<typeof appendInjectedAssistantMessageToTranscript>>;
  try {
    const admission = await beginSessionWorkAdmission({
      agentId,
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {
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
          sessionId,
          storePath,
          agentId,
          config: cfg,
        });
      });
    } finally {
      admission.release();
    }
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    return;
  } finally {
    retained?.release();
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

  respond(true, { ok: true, messageId: appended.messageId });
}

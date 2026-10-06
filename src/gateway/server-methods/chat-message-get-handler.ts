import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validateChatMessageGetParams } from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { readSessionPendingInput } from "../../config/sessions/session-accessor.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { prepareForwardedMessageCronJobNameResolver } from "../chat-display-projection.history.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  projectChatDisplayMessage,
} from "../chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { projectOperatorModelRead } from "../operator-model-presentation.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { resolveSessionModelRef } from "../session-utils.js";
import { readChatHistoryMessageById } from "./chat-history-pages.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import { projectPendingInputMessage } from "./chat-pending-inputs.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const chatMessageGetHandlers: GatewayRequestHandlers = {
  "chat.message.get": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
    signal,
  }) => {
    if (!assertValidParams(params, validateChatMessageGetParams, "chat.message.get", respond)) {
      return;
    }
    const { sessionKey, messageId, maxChars } = params;
    const agentIdOverride = normalizeOptionalString(params.agentId);
    const selection = await prepareChatHistorySessionRead({
      context,
      client,
      respond,
      sessionMutationAuthorization,
      signal,
      method: "chat.message.get",
      sessionKey,
      agentIdOverride,
    });
    if (!selection) {
      return;
    }
    try {
      const { selectedSession, entry, queries, readCurrentSharing, rowProjection } = selection;
      const { cfg, agentId: sessionAgentId, storePath, canonicalKey } = selectedSession;
      const sessionId = entry?.sessionId;
      const withCurrentSession = <T>(consume: () => T) =>
        withReadySessionRows(rowProjection, queries, (read) => {
          signal?.throwIfAborted();
          return readCurrentSharing(read) ? consume() : undefined;
        });
      if (!sessionId) {
        await withCurrentSession(() =>
          respond(true, { ok: false, unavailableReason: "not_found" }),
        );
        return;
      }
      const effectiveMaxChars = maxChars ?? Math.min(MAX_PAYLOAD_BYTES, 1_000_000);
      if (messageId.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)) {
        // Pending IDs have their own owner. A transcript miss must never widen
        // into pending custody or an archived physical session.
        const pending = await readSessionPendingInput(
          {
            agentId: sessionAgentId,
            sessionKey: canonicalKey,
            sessionId,
            storePath,
          },
          messageId.slice(CHAT_PENDING_INPUT_MESSAGE_PREFIX.length),
        );
        if (!(await withCurrentSession(() => true))) {
          return;
        }
        if (!pending) {
          await withCurrentSession(() =>
            respond(true, { ok: false, unavailableReason: "not_found" }),
          );
          return;
        }
        const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(
          [pending.message],
          context.cronStorePath,
        );
        await withCurrentSession(() => {
          const message = projectPendingInputMessage(
            pending,
            effectiveMaxChars,
            undefined,
            resolveCronJobName,
          );
          if (!message) {
            respond(true, { ok: false, unavailableReason: "not_visible" });
            return;
          }
          respond(
            true,
            jsonUtf8Bytes(message) > MAX_PAYLOAD_BYTES - 1024
              ? { ok: false, unavailableReason: "oversized" }
              : { ok: true, message },
          );
        });
        return;
      }
      const resolved = await readChatHistoryMessageById({
        entry,
        provider: getCliSessionBinding(entry, "claude-cli")?.sessionId
          ? resolveSessionModelRef(cfg, entry, sessionAgentId, {
              allowPluginNormalization: false,
            }).provider
          : undefined,
        sessionAgentId,
        sessionId,
        canonicalKey,
        storePath,
        messageId,
        max: 1,
        maxHistoryBytes: MAX_PAYLOAD_BYTES,
        effectiveMaxChars,
        offset: undefined,
      });
      // Async transcript/archive reads cannot publish under a stale sharing or
      // physical-session snapshot.
      if (!(await withCurrentSession(() => true))) {
        return;
      }
      if (!resolved.found) {
        await withCurrentSession(() =>
          respond(true, { ok: false, unavailableReason: "not_found" }),
        );
        return;
      }
      if (resolved.oversized) {
        await withCurrentSession(() =>
          respond(true, { ok: false, unavailableReason: "oversized" }),
        );
        return;
      }
      const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(
        [resolved.message],
        context.cronStorePath,
      );
      await withCurrentSession(() => {
        const projectedMessage = resolved.message
          ? projectChatDisplayMessage(resolved.message, {
              maxChars: effectiveMaxChars,
              resolveCurrentUserProfileDisplay,
              resolveCronJobName,
            })
          : undefined;
        const projected = projectedMessage
          ? augmentChatHistoryWithCanvasBlocks([projectedMessage])[0]
          : undefined;
        if (!projected) {
          respond(true, { ok: false, unavailableReason: "not_visible" });
          return;
        }

        // maxChars bounds individual text fields, not the serialized message: many
        // blocks or structured output must not bypass the WebSocket payload limit.
        respond(
          true,
          jsonUtf8Bytes(projected) > MAX_PAYLOAD_BYTES - 1024
            ? { ok: false, unavailableReason: "oversized" }
            : projectOperatorModelRead(
                { context, client, agentId: sessionAgentId },
                { ok: true, message: projected },
              ),
        );
      });
    } finally {
      selection.release();
    }
  },
};

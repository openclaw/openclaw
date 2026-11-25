import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatPendingInputsOwnParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readSessionPendingInput } from "../../config/sessions/session-accessor.js";
import { dismissRetiredSessionPendingInputs } from "../../config/sessions/session-pending-input-withdrawal.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { extractProjectedText } from "../chat-display-projection.helpers.js";
import { MAX_PAYLOAD_BYTES } from "../payload-limits.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { prepareSessionSharingRead } from "../session-sharing-target-read.js";
import { readChatPendingInputs } from "./chat-pending-inputs.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

/** Author custody survives membership removal; this never discloses session history or metadata. */
export const chatPendingInputsOwnHandlers: GatewayRequestHandlers = {
  "chat.pendingInputs.own": defineValidatedGatewayHandler(
    "chat.pendingInputs.own",
    validateChatPendingInputsOwnParams,
    async ({ params, client, context, respond, signal }) => {
      const profileId = client?.authenticatedUserProfile?.profileId;
      if (!profileId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "A signed-in profile is required."),
        );
        return;
      }
      const empty = params.inputId
        ? { text: null }
        : { pendingInputs: { items: [], total: 0, queuedCount: 0 } };
      if (isIncognitoSessionKey(params.sessionKey)) {
        respond(true, empty);
        return;
      }
      const cfg = context.getRuntimeConfig();
      const agent = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId, "read");
      if (!agent.ok) {
        respond(false, undefined, agent.error);
        return;
      }
      const prepared = await prepareSessionSharingRead({
        cfg,
        sessionKey: params.sessionKey,
        agentId: agent.agentId,
        projection: getSessionRowProjection(context),
      });
      try {
        const { target } = prepared.readCurrent(context.getRuntimeConfig());
        if (!target) {
          respond(true, empty);
          return;
        }
        const scope = {
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          sessionId: target.entry.sessionId,
          storePath: prepared.storageTarget.storePath,
        };
        const audience = { profileId, revokedOnly: true as const };
        const assertCurrent = () => {
          signal?.throwIfAborted();
          prepared.readCurrent(context.getRuntimeConfig());
        };
        if (params.inputId) {
          const pending = await readSessionPendingInput(scope, params.inputId);
          assertCurrent();
          if (
            !pending ||
            pending.state !== "cancelled" ||
            pending.endCause !== "revoked" ||
            pending.message.display === false ||
            asOptionalRecord(asOptionalRecord(pending.message["__openclaw"])?.requesterOrigin)
              ?.operatorProfileId !== profileId
          ) {
            respond(true, { text: null });
            return;
          }
          const result = {
            text: extractProjectedText(pending.message.content),
          };
          if (jsonUtf8Bytes(result) > MAX_PAYLOAD_BYTES - 1024) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, "The queued message is too large to copy."),
            );
          } else {
            respond(true, result);
          }
          return;
        }
        if (params.inputIds) {
          const outcome = await dismissRetiredSessionPendingInputs(
            scope,
            params.inputIds,
            assertCurrent,
            audience,
          );
          if (outcome.kind !== "dismissed") {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                "Couldn’t remove the queued message. Try again.",
              ),
            );
            return;
          }
        }
        const pendingInputs = await readChatPendingInputs(scope, {
          audience,
          before: params.before,
          limit: 20,
          maxChars: 1_000_000,
        });
        assertCurrent();
        respond(true, {
          ...(pendingInputs.items.length ? { sessionId: scope.sessionId } : {}),
          pendingInputs: { ...pendingInputs, queuedCount: 0 },
        });
      } finally {
        prepared.release();
      }
    },
  ),
};

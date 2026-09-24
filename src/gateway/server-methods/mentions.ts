import {
  ErrorCodes,
  errorShape,
  validateMentionsDismissParams,
  validateMentionsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const mentionHandlers: GatewayRequestHandlers = {
  "mentions.list": async ({ client, context, params, respond }) => {
    if (!assertValidParams(params, validateMentionsListParams, "mentions.list", respond)) {
      return;
    }
    if (!context.mentionInbox) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry."),
      );
      return;
    }
    await context.mentionInbox.list(client, (result) => {
      respond(
        result.ok,
        result.ok ? result.value : undefined,
        result.ok ? undefined : result.error,
      );
    });
  },
  "mentions.dismiss": async ({ client, context, params, respond }) => {
    if (!assertValidParams(params, validateMentionsDismissParams, "mentions.dismiss", respond)) {
      return;
    }
    if (!context.mentionInbox) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry."),
      );
      return;
    }
    await context.mentionInbox.dismiss(client, params.ids, (result) => {
      respond(
        result.ok,
        result.ok ? result.value : undefined,
        result.ok ? undefined : result.error,
      );
    });
  },
};

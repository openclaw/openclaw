import {
  ErrorCodes,
  errorShape,
  validateMentionsDismissParams,
  validateMentionsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

function mentionHandler(
  method: "mentions.list" | "mentions.dismiss",
  validate: Validator<{ ids?: string[] }>,
): GatewayRequestHandler {
  return async ({ client, context, params, respond }) => {
    if (!assertValidParams(params, validate, method, respond)) {
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
    const publish: Parameters<typeof context.mentionInbox.listAsync>[1] = (result) => {
      respond(
        result.ok,
        result.ok ? result.value : undefined,
        result.ok ? undefined : result.error,
      );
    };
    if (params.ids) {
      await context.mentionInbox.dismissAsync(client, params.ids, publish);
    } else {
      await context.mentionInbox.listAsync(client, publish);
    }
  };
}

export const mentionHandlers: GatewayRequestHandlers = {
  "mentions.list": mentionHandler("mentions.list", validateMentionsListParams),
  "mentions.dismiss": mentionHandler("mentions.dismiss", validateMentionsDismissParams),
};

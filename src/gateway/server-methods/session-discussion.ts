import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionDiscussionInfoParams,
  validateSessionDiscussionInfoResult,
  validateSessionDiscussionOpenParams,
  validateSessionDiscussionOpenResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { getSessionDiscussionProvider } from "../../plugins/session-discussion-registry.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionDiscussionHandlers: GatewayRequestHandlers = {
  "session.discussion.info": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionDiscussionInfoParams,
        "session.discussion.info",
        respond,
      )
    ) {
      return;
    }
    const provider = getSessionDiscussionProvider();
    if (!provider) {
      respond(true, { state: "none" }, undefined);
      return;
    }
    try {
      const result = await provider.info({ sessionKey: params.sessionKey });
      if (!validateSessionDiscussionInfoResult(result)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `invalid session.discussion.info result: ${formatValidationErrors(validateSessionDiscussionInfoResult.errors)}`,
          ),
        );
        return;
      }
      respond(true, result, undefined);
    } catch {
      respond(true, { state: "none" }, undefined);
    }
  },
  "session.discussion.open": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionDiscussionOpenParams,
        "session.discussion.open",
        respond,
      )
    ) {
      return;
    }
    const provider = getSessionDiscussionProvider();
    if (!provider) {
      respond(true, { state: "none" }, undefined);
      return;
    }
    try {
      const result = await provider.open({ sessionKey: params.sessionKey });
      if (!validateSessionDiscussionOpenResult(result)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `invalid session.discussion.open result: ${formatValidationErrors(validateSessionDiscussionOpenResult.errors)}`,
          ),
        );
        return;
      }
      respond(true, result, undefined);
    } catch {
      respond(true, { state: "none" }, undefined);
    }
  },
};

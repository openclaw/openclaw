import {
  ErrorCodes,
  errorShape,
  validateAgentsAvatarGenerateParams,
  validateAgentsAvatarGenerateResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { generateBlobsterForAgent } from "../../agents/blobster-generation.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const agentAvatarGenerateHandler = defineValidatedGatewayMethod(
  "agents.avatar.generate",
  validateAgentsAvatarGenerateParams,
  async ({ params, respond, context, client, signal, hasCurrentClientAuthority }) => {
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (hasCurrentClientAuthority?.() === false) {
        throw new Error("Avatar generation access changed. Reconnect and try again.");
      }
    };
    const operator = await captureGatewayOperatorRunAuthority({
      client,
      context,
      hasCurrentClientAuthority,
      invocationAuthority: { assertCurrent, signal },
    });
    if (!operator) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "Avatar generation requires an authenticated operator."),
      );
      return;
    }
    try {
      assertCurrent();
      const result = await generateBlobsterForAgent({
        cfg: context.getRuntimeConfig(),
        agentId: params.agentId,
        prompt: params.prompt,
        assertCurrent,
        operatorAuthority: operator.authority,
        signal,
      });
      assertCurrent();
      if (!validateAgentsAvatarGenerateResult(result)) {
        throw new Error("Invalid avatar preview.");
      }
      respond(true, result, undefined);
    } finally {
      operator.release();
    }
  },
  // Provider output and account details must not be reflected to the browser.
  () =>
    errorShape(
      ErrorCodes.UNAVAILABLE,
      "Could not generate a valid Blobster with the selected model.",
    ),
);

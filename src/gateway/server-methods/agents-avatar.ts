import {
  ErrorCodes,
  errorShape,
  validateAgentsAvatarGenerateParams,
  validateAgentsAvatarGenerateResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  BlobsterGenerationAuthorityChangedError,
  BlobsterUnsupportedRuntimeError,
} from "../../agents/blobster-generation-errors.js";
import { isLlmOperatorAuthorizationError } from "../../plugins/runtime/runtime-llm-error.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const agentAvatarGenerateHandler = defineValidatedGatewayMethod(
  "agents.avatar.generate",
  validateAgentsAvatarGenerateParams,
  async ({ params, respond, context, client, signal, hasCurrentClientAuthority }) => {
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (hasCurrentClientAuthority?.() === false) {
        throw new BlobsterGenerationAuthorityChangedError();
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
      const { generateBlobsterForAgent } = await import("../../agents/blobster-generation.js");
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
  (error) => {
    if (error instanceof BlobsterGenerationAuthorityChangedError) {
      return errorShape(ErrorCodes.UNAVAILABLE, error.message);
    }
    if (isLlmOperatorAuthorizationError(error)) {
      return errorShape(
        ErrorCodes.FORBIDDEN,
        "Avatar generation is not authorized for this operator or model. Choose an allowed model or ask a Gateway administrator to update your role's model policy.",
      );
    }
    if (error instanceof BlobsterUnsupportedRuntimeError) {
      return errorShape(
        ErrorCodes.UNAVAILABLE,
        "The selected agent runtime cannot generate avatars without tools. Choose a supported runtime and try again.",
      );
    }
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      "Could not generate a valid Blobster with the selected model. Try a shorter description or another configured model.",
    );
  },
);

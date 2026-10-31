import { extractEmbeddedAssistantText } from "../agents/embedded-agent-utils.js";
import type { AssistantMessage } from "../llm/types.js";

export class MediaAssistantNoTextError extends Error {}

export function createMediaAssistantTextCoercer(kind: "Image" | "PDF") {
  return (params: { message: AssistantMessage; provider: string; model: string }): string => {
    const label = `${params.provider}/${params.model}`;
    const errorMessage = params.message.errorMessage?.trim();
    if (
      params.message.stopReason === "error" ||
      params.message.stopReason === "aborted" ||
      errorMessage
    ) {
      throw new Error(
        errorMessage
          ? `${kind} model failed (${label}): ${errorMessage}`
          : `${kind} model failed (${label})`,
      );
    }
    const text = extractEmbeddedAssistantText(params.message).trim();
    if (text) {
      return text;
    }
    throw new MediaAssistantNoTextError(`${kind} model returned no text (${label}).`);
  };
}

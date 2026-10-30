import type { AssistantMessage } from "../../llm/types.js";
import { extractEmbeddedAssistantText } from "../embedded-agent-utils.js";

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
    throw new Error(`${kind} model returned no text (${label}).`);
  };
}

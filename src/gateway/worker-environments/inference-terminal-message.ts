import type { WorkerInferenceTerminalOutcome } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { AssistantMessage, Usage } from "../../llm/types.js";
import {
  projectWorkerAssistantContent,
  projectWorkerTokenUsage,
} from "../../worker/assistant-message-projection.js";
import {
  projectWorkerProviderReplay,
  type WorkerMessageProjection,
} from "../../worker/transcript-message.js";

export type WorkerInferenceModelIdentity = {
  api: string;
  provider: string;
  model: string;
};

export const ERROR_MESSAGES = {
  "model-not-approved": "Model is not approved for this agent.",
  "invalid-context": "Inference context is invalid.",
  "epoch-mismatch": "Worker run epoch does not match.",
  "session-not-attached": "Worker session is not attached.",
  "provider-error": "Model provider request failed.",
  cancelled: "Inference request was cancelled.",
} as const satisfies Record<
  Extract<WorkerInferenceTerminalOutcome, { type: "error" }>["reason"],
  string
>;

export function inferenceError(
  reason: Extract<WorkerInferenceTerminalOutcome, { type: "error" }>["reason"],
  usage?: Usage,
  message: string = ERROR_MESSAGES[reason],
): WorkerInferenceTerminalOutcome {
  return {
    type: "error",
    reason,
    message,
    ...(usage ? { usage: structuredClone(usage) } : {}),
  };
}

export function projectWorkerInferenceTerminalMessage(params: {
  message: AssistantMessage;
  modelIdentity: WorkerInferenceModelIdentity;
  stopReason: Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">;
}): WorkerMessageProjection<Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"]> {
  const usage = params.message.usage;
  const projected: Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"] = {
    role: "assistant",
    content: params.message.content.map((part) => {
      if (part.type !== "text" && part.type !== "thinking" && part.type !== "toolCall") {
        throw new Error("Unsupported assistant terminal content");
      }
      return projectWorkerAssistantContent(part);
    }),
    api: params.modelIdentity.api,
    provider: params.modelIdentity.provider,
    model: params.modelIdentity.model,
    ...(params.message.responseModel ? { responseModel: params.message.responseModel } : {}),
    ...(params.message.responseId ? { responseId: params.message.responseId } : {}),
    usage: {
      ...projectWorkerTokenUsage(usage),
      ...(usage.contextUsage?.state === "available"
        ? {
            contextUsage: {
              state: usage.contextUsage.state,
              promptTokens: usage.contextUsage.promptTokens,
              totalTokens: usage.contextUsage.totalTokens,
            },
          }
        : usage.contextUsage?.state === "unavailable"
          ? { contextUsage: { state: usage.contextUsage.state } }
          : {}),
    },
    stopReason: params.stopReason,
    timestamp: params.message.timestamp,
  };
  return projectWorkerProviderReplay({
    message: projected,
    providerReplay: params.message.providerReplay,
    purpose: "transcript",
  });
}

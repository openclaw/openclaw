import { LiveSessionModelSwitchError } from "../live-model-switch-error.js";
import type { AgentWorkerToParentMessage, SerializedWorkerError } from "./agent-runtime.types.js";

function serializeControlError(error: Error): Pick<SerializedWorkerError, "control"> | undefined {
  if (error instanceof LiveSessionModelSwitchError) {
    return {
      control: {
        type: "liveSessionModelSwitch",
        provider: error.provider,
        model: error.model,
        ...(error.authProfileId ? { authProfileId: error.authProfileId } : {}),
        ...(error.authProfileIdSource ? { authProfileIdSource: error.authProfileIdSource } : {}),
      },
    };
  }
  return undefined;
}

function deserializeControlError(error: SerializedWorkerError): Error | undefined {
  if (error.control?.type === "liveSessionModelSwitch") {
    return new LiveSessionModelSwitchError({
      provider: error.control.provider,
      model: error.control.model,
      ...(error.control.authProfileId ? { authProfileId: error.control.authProfileId } : {}),
      ...(error.control.authProfileIdSource
        ? { authProfileIdSource: error.control.authProfileIdSource }
        : {}),
    });
  }
  return undefined;
}

export function serializeWorkerError(error: unknown): AgentWorkerToParentMessage {
  if (error instanceof Error) {
    const code =
      typeof (error as Error & { code?: unknown }).code === "string"
        ? (error as Error & { code: string }).code
        : undefined;
    return {
      type: "error",
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(code ? { code } : {}),
        ...serializeControlError(error),
      },
    };
  }
  return { type: "error", error: { message: String(error) } };
}

export function deserializeWorkerError(
  message: AgentWorkerToParentMessage & { type: "error" },
): Error {
  const error = deserializeControlError(message.error) ?? new Error(message.error.message);
  if (!message.error.control) {
    error.name = message.error.name ?? "AgentWorkerError";
  }
  if (message.error.stack) {
    error.stack = message.error.stack;
  }
  if (message.error.code) {
    (error as Error & { code?: string }).code = message.error.code;
  }
  return error;
}

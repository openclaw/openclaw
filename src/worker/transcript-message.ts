import { asOptionalRecord } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import {
  WorkerRuntimeContextMessageSchema,
  WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerTranscriptCommitRequestFrame,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { isWorkerTranscriptFrameWithinBudget } from "../../packages/gateway-protocol/src/worker-transcript-budget.js";
import { redactAgentDiagnosticPayload } from "../agents/diagnostic-redaction.js";
import type { AssistantMessage, ProviderReplayState } from "../llm/types.js";
import {
  projectWorkerAssistantContent,
  projectWorkerTextOrImageContent,
  projectWorkerTokenUsage,
} from "./assistant-message-projection.js";

const SIZE_FRAME_ID = "00000000-0000-4000-8000-000000000000";
type WorkerTranscriptAssistantMessage = Extract<WorkerTranscriptMessage, { role: "assistant" }>;
export type WorkerProviderReplayUnavailable = {
  bytes: number;
  limitBytes: number;
  reason: "provider-replay-data-budget" | "transcript-commit-frame-budget";
};
type WorkerProviderReplayUnavailableProjection = {
  kind: "provider-replay-unavailable";
  details: WorkerProviderReplayUnavailable;
};
export type WorkerMessageProjection<T> =
  | { kind: "complete"; message: T }
  | WorkerProviderReplayUnavailableProjection;
type WorkerMessageProjectionPurpose = "inference" | "launch" | "transcript";
export const WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE =
  "Cloud worker could not preserve authoritative provider replay. " +
  "Stop or reclaim the cloud worker, then retry locally.";

function providerReplayUnavailable(
  details: WorkerProviderReplayUnavailable,
): WorkerProviderReplayUnavailableProjection {
  return { kind: "provider-replay-unavailable", details };
}

function cloneProviderReplay(state: ProviderReplayState): ProviderReplayState {
  return {
    v: state.v,
    type: state.type,
    ...(state.id === undefined ? {} : { id: state.id }),
    data: state.data,
    ...(state.replayIndex === undefined ? {} : { replayIndex: state.replayIndex }),
    provider: state.provider,
    api: state.api,
    model: state.model,
    ...(state.baseUrlHash === undefined ? {} : { baseUrlHash: state.baseUrlHash }),
    ...(state.sessionHash === undefined ? {} : { sessionHash: state.sessionHash }),
    ...(state.authProfileHash === undefined ? {} : { authProfileHash: state.authProfileHash }),
  };
}

function redactWorkerDiagnosticText(value: string): string {
  const redacted = redactAgentDiagnosticPayload(value);
  return typeof redacted === "string" ? redacted : "[unreadable diagnostic text]";
}

function projectWorkerDiagnostic(diagnostic: NonNullable<AssistantMessage["diagnostics"]>[number]) {
  const details = asOptionalRecord(redactAgentDiagnosticPayload(diagnostic.details));
  const error = diagnostic.error;
  return {
    type: diagnostic.type,
    timestamp: diagnostic.timestamp,
    ...(error
      ? {
          error: {
            message: redactWorkerDiagnosticText(error.message),
            ...(error.name ? { name: redactWorkerDiagnosticText(error.name) } : {}),
            ...(error.stack ? { stack: redactWorkerDiagnosticText(error.stack) } : {}),
            ...(error.code === undefined ? {} : { code: error.code }),
          },
        }
      : {}),
    ...(details ? { details } : {}),
  };
}

function workerTranscriptMessageFrame(
  message: WorkerTranscriptMessage,
): WorkerTranscriptCommitRequestFrame {
  return {
    type: "req",
    id: SIZE_FRAME_ID,
    method: "worker.transcript.commit",
    params: {
      runEpoch: Number.MAX_SAFE_INTEGER,
      seq: Number.MAX_SAFE_INTEGER,
      baseLeafId: "x".repeat(WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH),
      messages: [message],
    },
  };
}

function workerTranscriptMessageFrameBytes(message: WorkerTranscriptMessage): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(workerTranscriptMessageFrame(message)), "utf8");
  } catch {
    return undefined;
  }
}

export function projectWorkerProviderReplay<
  TMessage extends WorkerTranscriptAssistantMessage,
>(params: {
  message: TMessage;
  providerReplay: ProviderReplayState | undefined;
  purpose: WorkerMessageProjectionPurpose;
}): WorkerMessageProjection<TMessage> {
  if (!params.providerReplay) {
    return { kind: "complete", message: params.message };
  }
  const dataBytes = Buffer.byteLength(params.providerReplay.data, "utf8");
  if (dataBytes > WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES) {
    return providerReplayUnavailable({
      bytes: dataBytes,
      limitBytes: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
      reason: "provider-replay-data-budget",
    });
  }
  const candidate = {
    ...params.message,
    providerReplay: cloneProviderReplay(params.providerReplay),
  };
  if (params.purpose !== "transcript") {
    return { kind: "complete", message: candidate };
  }
  const frameBytes = workerTranscriptMessageFrameBytes(candidate);
  if (frameBytes === undefined || frameBytes > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
    return providerReplayUnavailable({
      bytes: frameBytes ?? WORKER_PROTOCOL_MAX_PAYLOAD_BYTES + 1,
      limitBytes: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
      reason: "transcript-commit-frame-budget",
    });
  }
  return { kind: "complete", message: candidate };
}

function toWorkerAssistantMessage(message: AssistantMessage): WorkerTranscriptAssistantMessage {
  return {
    role: "assistant",
    content: message.content.map(projectWorkerAssistantContent),
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.diagnostics
      ? { diagnostics: message.diagnostics.map(projectWorkerDiagnostic) }
      : {}),
    usage: {
      ...projectWorkerTokenUsage(message.usage),
      ...(message.usage.contextUsage
        ? { contextUsage: structuredClone(message.usage.contextUsage) }
        : {}),
    },
    stopReason: message.stopReason,
    ...(message.errorMessage
      ? { errorMessage: redactWorkerDiagnosticText(message.errorMessage) }
      : {}),
    ...(message.errorCode ? { errorCode: message.errorCode } : {}),
    ...(message.errorType ? { errorType: message.errorType } : {}),
    ...(message.errorBody ? { errorBody: redactWorkerDiagnosticText(message.errorBody) } : {}),
    timestamp: message.timestamp,
  };
}

export function toWorkerTranscriptMessage(
  message: AgentMessage,
  purpose: "inference",
): WorkerMessageProjection<Exclude<WorkerTranscriptMessage, { role: "custom" }>> | undefined;
export function toWorkerTranscriptMessage(
  message: AgentMessage,
  purpose: "transcript" | "launch",
): WorkerMessageProjection<WorkerTranscriptMessage> | undefined;
export function toWorkerTranscriptMessage(
  message: AgentMessage,
  purpose: WorkerMessageProjectionPurpose,
): WorkerMessageProjection<WorkerTranscriptMessage> | undefined {
  if (
    message.role === "custom" &&
    (message.customType === "openclaw.runtime-context" ||
      message.customType === "openclaw.system-update") &&
    purpose !== "inference"
  ) {
    const candidate = {
      role: message.role,
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      timestamp: message.timestamp,
    };
    if (!Value.Check(WorkerRuntimeContextMessageSchema, candidate)) {
      throw new Error("Invalid worker runtime context");
    }
    return { kind: "complete", message: candidate };
  }
  if (message.role === "user") {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content.map(projectWorkerTextOrImageContent);
    return {
      kind: "complete",
      message: {
        role: "user",
        content,
        timestamp: message.timestamp,
        ...(message.operatorMessage ? { operatorMessage: message.operatorMessage } : {}),
      },
    };
  }
  if (message.role === "assistant") {
    return projectWorkerProviderReplay({
      message: toWorkerAssistantMessage(message),
      providerReplay: message.providerReplay,
      purpose,
    });
  }
  if (message.role === "toolResult") {
    return {
      kind: "complete",
      message: {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content.map(projectWorkerTextOrImageContent),
        ...(message.details === undefined
          ? {}
          : { details: redactAgentDiagnosticPayload(message.details) }),
        isError: message.isError,
        timestamp: message.timestamp,
      },
    };
  }
  return undefined;
}

export function isWorkerTranscriptMessageFrameSafe(message: WorkerTranscriptMessage): boolean {
  return isWorkerTranscriptFrameWithinBudget(workerTranscriptMessageFrame(message));
}

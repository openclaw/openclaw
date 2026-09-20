import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import type { AgentStreamParams, ClientToolDefinition } from "../agents/command/shared-types.js";
import type { ImageContent } from "../agents/command/types.js";
import { readAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../runtime.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

export type OpenAiCompatiblePendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export function readOpenAiHttpRunTerminal(result: unknown): {
  runFailed: boolean;
  stopReason: string | undefined;
  pendingToolCalls: OpenAiCompatiblePendingToolCall[] | undefined;
} {
  const meta = isRecord(result) ? result.meta : undefined;
  if (!isRecord(meta)) {
    return {
      runFailed: readAgentRunTerminalOutcome(result) === "failed",
      stopReason: undefined,
      pendingToolCalls: undefined,
    };
  }
  const stopReasonRaw = meta.stopReason;
  const stopReason = typeof stopReasonRaw === "string" ? stopReasonRaw : undefined;
  const pendingRaw = meta.pendingToolCalls;
  if (!Array.isArray(pendingRaw)) {
    return {
      runFailed: readAgentRunTerminalOutcome(result) === "failed",
      stopReason,
      pendingToolCalls: undefined,
    };
  }
  const pendingToolCalls: OpenAiCompatiblePendingToolCall[] = [];
  for (const call of pendingRaw) {
    const record = isRecord(call) ? call : undefined;
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    const argsValue = record?.arguments;
    const argumentsValue =
      typeof argsValue === "string"
        ? argsValue
        : argsValue == null
          ? ""
          : JSON.stringify(argsValue);
    if (id && name) {
      pendingToolCalls.push({ id, name, arguments: argumentsValue });
    }
  }
  return {
    runFailed: readAgentRunTerminalOutcome(result) === "failed",
    stopReason,
    pendingToolCalls,
  };
}

export async function runOpenAiCompatibleAgentCommand(params: {
  message: string;
  images?: ImageContent[];
  clientTools?: ClientToolDefinition[];
  extraSystemPrompt?: string;
  modelOverride?: string;
  streamParams?: AgentStreamParams;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  abortSignal?: AbortSignal;
  resolveGatewayContext?: GatewayContextResolver;
}) {
  return agentCommandFromGatewayIngress(
    {
      message: params.message,
      images: params.images?.length ? params.images : undefined,
      clientTools: params.clientTools?.length ? params.clientTools : undefined,
      extraSystemPrompt: params.extraSystemPrompt || undefined,
      model: params.modelOverride,
      streamParams: params.streamParams,
      sessionKey: params.sessionKey,
      runId: params.runId,
      deliver: false,
      messageChannel: params.messageChannel,
      senderIsOwner: params.senderIsOwner,
      bestEffortDeliver: false,
      allowModelOverride: params.modelOverride !== undefined,
      abortSignal: params.abortSignal,
      ...(params.resolveGatewayContext
        ? {
            onAdmittedRunContext: (context: AdmittedRunContext) =>
              bindGatewayContextResolver(context, params.resolveGatewayContext),
          }
        : {}),
    },
    defaultRuntime,
    createDefaultDeps(),
    {},
  );
}

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import type { AgentStreamParams, ClientToolDefinition } from "../agents/command/shared-types.js";
import type { ImageContent } from "../agents/command/types.js";
import { readAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../runtime.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

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
  requestAuth: AuthorizedGatewayHttpRequest;
  operatorScopes: readonly string[];
  abortSignal?: AbortSignal;
  resolveGatewayContext?: GatewayContextResolver;
}) {
  params.abortSignal?.throwIfAborted();
  const client = createSyntheticPluginRuntimeClient({
    authenticatedUserProfile: params.requestAuth.authenticatedUserProfile,
    operatorRoleActor: params.requestAuth.operatorRoleActor,
    scopes: [...params.operatorScopes],
  });
  const operator = resolveGatewayOperatorRoleActor(client)?.kind === "operator";
  const gatewayContext = operator ? params.resolveGatewayContext?.() : undefined;
  if (operator && !gatewayContext) {
    throw new Error("OpenAI-compatible operator execution requires a current Gateway context.");
  }
  const captured = gatewayContext
    ? captureGatewayOperatorRunAuthority({
        client,
        context: {
          getRuntimeConfig: gatewayContext.getRuntimeConfig,
          getCommittedRuntimeConfig: gatewayContext.getCommittedRuntimeConfig,
          resolveGatewayContext: params.resolveGatewayContext,
        },
        sourceAuthority: params.requestAuth.operatorAccessAuthority,
      })
    : undefined;
  try {
    const sourceSignal = captured?.authority.signal;
    const abortSignal =
      params.abortSignal && sourceSignal
        ? AbortSignal.any([params.abortSignal, sourceSignal])
        : (params.abortSignal ?? sourceSignal);
    abortSignal?.throwIfAborted();
    const result = await agentCommandFromGatewayIngress(
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
        abortSignal,
        operatorAuthority: captured?.authority,
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
    captured?.authority.assertCurrent();
    return result;
  } finally {
    captured?.release();
  }
}

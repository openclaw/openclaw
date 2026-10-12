import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isClientToolNameConflictError } from "../agents/agent-tool-definition-adapter.js";
import type { AgentStreamParams, ClientToolDefinition } from "../agents/command/shared-types.js";
import type { ImageContent } from "../agents/command/types.js";
import { isFailoverError, isSignalTimeoutReason } from "../agents/failover/error.js";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import { readAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { getRuntimeConfig } from "../config/io.js";
import { isAbortError } from "../infra/abort-signal.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../runtime.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { resolveOpenAiCompatError, type OpenAiCompatError } from "./openai-compat-errors.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { areGatewayUploadsEnabled, GATEWAY_UPLOADS_DISABLED_MESSAGE } from "./upload-policy.js";

export type OpenAiCompatibleHttpOptions<TConfig> = GatewayHttpRequestAuthOptions & {
  config?: TConfig;
  maxBodyBytes?: number;
  resolveGatewayContext?: GatewayContextResolver;
};

export type OpenAiCompatiblePendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

// Provider failures reach this boundary as FailoverErrors and run budgets abort with a
// TimeoutError; a bare abort is Gateway-owned cancellation, not an upstream provider timeout.
function isGatewayRunCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object" || isFailoverError(error) || !isAbortError(error)) {
    return false;
  }
  return !isSignalTimeoutReason("cause" in error ? error.cause : undefined);
}

export function resolveOpenAiCompatibleAgentError(
  error: unknown,
  fallback?: OpenAiCompatError["error"],
): OpenAiCompatError {
  if (isClientToolNameConflictError(error)) {
    return {
      status: 400,
      error: { message: "invalid tool configuration", type: "invalid_request_error" },
    };
  }
  if (isGatewayRunCancellation(error)) {
    return { status: 500, error: { message: "agent run was cancelled", type: "api_error" } };
  }
  return (
    resolveOpenAiCompatError(error) ?? {
      status: 500,
      error: fallback ?? { message: "internal error", type: "api_error" },
    }
  );
}

export function readOpenAiHttpRunTerminal(result: unknown): {
  runFailed: boolean;
  stopReason: string | undefined;
  pendingToolCalls: OpenAiCompatiblePendingToolCall[] | undefined;
} {
  const meta = asOptionalRecord(asOptionalRecord(result)?.meta);
  const stopReasonRaw = meta?.stopReason;
  const stopReason = typeof stopReasonRaw === "string" ? stopReasonRaw : undefined;
  const pendingRaw = meta?.pendingToolCalls;
  const pendingToolCalls = Array.isArray(pendingRaw)
    ? pendingRaw.flatMap((call): OpenAiCompatiblePendingToolCall[] => {
        const record = asOptionalRecord(call);
        const id = typeof record?.id === "string" ? record.id.trim() : "";
        const name = typeof record?.name === "string" ? record.name.trim() : "";
        const argsValue = record?.arguments;
        const argumentsValue =
          typeof argsValue === "string"
            ? argsValue
            : argsValue == null
              ? ""
              : JSON.stringify(argsValue);
        return id && name ? [{ id, name, arguments: argumentsValue }] : [];
      })
    : undefined;
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
  // Command preparation otherwise derives the owner from the session key
  // alone, which can disagree with the agent the request resolved to.
  agentId: string;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  requestAuth: AuthorizedGatewayHttpRequest;
  operatorScopes: readonly string[];
  abortSignal?: AbortSignal;
  hasCurrentClientAuthority?: () => boolean;
  hasClientUploads?: boolean;
  resolveGatewayContext?: GatewayContextResolver;
}) {
  params.abortSignal?.throwIfAborted();
  let admitted = false;
  const assertSourceCurrent = () => {
    if (!admitted && params.hasClientUploads && !areGatewayUploadsEnabled(getRuntimeConfig())) {
      throw new ToolAuthorizationError(GATEWAY_UPLOADS_DISABLED_MESSAGE);
    }
    if (!admitted && params.hasCurrentClientAuthority?.() === false) {
      throw new ToolAuthorizationError("Gateway requester authority changed");
    }
  };
  assertSourceCurrent();
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
    ? await captureGatewayOperatorRunAuthority({
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
    assertSourceCurrent();
    captured?.authority.assertCurrent();
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
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        deliver: false,
        messageChannel: params.messageChannel,
        senderIsOwner: params.senderIsOwner,
        bestEffortDeliver: false,
        allowModelOverride: params.modelOverride !== undefined,
        abortSignal,
        operatorAuthority: captured?.authority,
        assertSourceCurrent,
        onAdmittedRunContext: (context) => {
          assertSourceCurrent();
          bindGatewayContextResolver(context, params.resolveGatewayContext);
          // Admission takes request custody; the retained run keeps its original access grant.
          admitted = true;
        },
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

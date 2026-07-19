// Tool invocation methods adapt gateway-visible tools to RPC callers with
// protocol-shaped success, approval-required, validation, and error payloads.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsInvokeParams,
  type ToolsInvokeResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  createAuthorizationInvocationContext,
  createAuthorizationPrincipal,
} from "../../plugins/authorization-policy-context.js";
import { resolveGatewayConversationReadOrigin } from "../conversation-read-origin.js";
import { invokeGatewayTool } from "../tools-invoke-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * RPC adapter for invoking gateway-visible tools from connected clients.
 */
function resolveRpcErrorCode(params: {
  type: "invalid_request" | "not_found" | "tool_call_blocked" | "tool_error";
  requiresApproval?: boolean;
}): string {
  if (params.requiresApproval) {
    return "requires_approval";
  }
  switch (params.type) {
    case "invalid_request":
      return "validation_error";
    case "not_found":
      return "not_found";
    case "tool_call_blocked":
      return "forbidden";
    case "tool_error":
      return "internal_error";
  }
  return "internal_error";
}

/** Handles `tools.invoke` with protocol-shaped success and failure payloads. */
export const toolsInvokeHandlers: GatewayRequestHandlers = {
  "tools.invoke": async ({ params, respond, context, client }) => {
    if (!validateToolsInvokeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.invoke params: ${formatValidationErrors(validateToolsInvokeParams.errors)}`,
        ),
      );
      return;
    }
    const requestedToolName = normalizeOptionalString(params.name);
    if (!requestedToolName) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid tools.invoke params: name required"),
      );
      return;
    }
    if (client?.internal?.agentRuntimeIdentity) {
      // Runtime connections are delegated agent callers. Their transport scopes
      // must never be promoted into an operator principal at this RPC boundary.
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "tools.invoke is not available to agent runtimes"),
      );
      return;
    }

    const operatorScopes = client?.connect?.scopes ?? [];
    const operatorIsOwner = operatorScopes.includes("operator.admin");
    const conversationId = normalizeOptionalString(params.conversationId);
    const threadId = normalizeOptionalString(params.threadId);
    const outcome = await invokeGatewayTool({
      cfg: context.getRuntimeConfig(),
      input: params,
      agentTo: conversationId,
      agentThreadId: threadId,
      senderIsOwner: operatorIsOwner,
      clientCaps: client?.connect?.caps,
      authorization: createAuthorizationInvocationContext({
        principal: createAuthorizationPrincipal({
          operatorScopes,
          operatorClientId: client?.pairedClientId,
          operatorDeviceId: client?.connect?.device?.id,
          operatorIsOwner,
        }),
        conversationId,
        threadId,
        trigger: "gateway",
      }),
      conversationReadOrigin: resolveGatewayConversationReadOrigin({
        client,
        requestedOrigin: params.conversationReadOrigin,
      }),
      toolCallIdPrefix: "rpc",
      approvalMode: params.confirm === true ? "request" : "report",
    });

    if (outcome.ok) {
      const payload: ToolsInvokeResult = {
        ok: true,
        toolName: outcome.toolName,
        output: outcome.result,
        source: outcome.source,
      };
      respond(true, payload, undefined);
      return;
    }

    const payload: ToolsInvokeResult = {
      ok: false,
      toolName: outcome.toolName || requestedToolName,
      ...(outcome.error.requiresApproval ? { requiresApproval: true } : {}),
      error: {
        code: resolveRpcErrorCode(outcome.error),
        message: outcome.error.message,
      },
    };
    respond(true, payload, undefined);
  },
};

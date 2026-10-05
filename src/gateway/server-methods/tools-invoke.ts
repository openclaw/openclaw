import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateToolsInvokeParams,
  type ToolsInvokeResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveGatewayConversationReadOrigin } from "../conversation-read-origin.js";
import { invokeGatewayTool } from "../tools-invoke-shared.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveRpcErrorCode(params: {
  type: "invalid_request" | "not_found" | "tool_call_blocked" | "tool_error";
  requiresApproval?: boolean;
}): string {
  if (params.requiresApproval) {
    return "requires_approval";
  }
  return (
    {
      invalid_request: "validation_error",
      not_found: "not_found",
      tool_call_blocked: "forbidden",
      tool_error: "internal_error",
    }[params.type] ?? "internal_error"
  );
}

export const toolsInvokeHandlers: GatewayRequestHandlers = {
  "tools.invoke": async (options) => {
    const { params, respond, context, client, signal } = options;
    if (!assertValidParams(params, validateToolsInvokeParams, "tools.invoke", respond)) {
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

    const outcome = await invokeGatewayTool({
      cfg: context.getRuntimeConfig(),
      input: params,
      authenticatedUserProfile: client?.authenticatedUserProfile,
      operatorRoleActor: client?.internal?.operatorRoleActor,
      operatorScopes: client?.connect.scopes,
      senderIsOwner: client?.connect?.scopes?.includes("operator.admin"),
      clientCaps: client?.connect?.caps,
      conversationReadOrigin: resolveGatewayConversationReadOrigin({
        client,
        requestedOrigin: params.conversationReadOrigin,
      }),
      toolCallIdPrefix: "rpc",
      approvalMode: params.confirm === true ? "request" : "report",
      signal,
      assertInvocationCurrent: readGatewayRequestMutationAuthority(options).assertCurrent,
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

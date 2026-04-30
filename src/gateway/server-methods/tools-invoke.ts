import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsInvokeParams,
} from "../protocol/index.js";
import { invokeGatewayTool } from "../tools-invoke-core.js";
import type { GatewayRequestHandlers } from "./types.js";

export const toolsInvokeHandlers: GatewayRequestHandlers = {
  "tools.invoke": async ({ params, respond, client, context }) => {
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

    const result = await invokeGatewayTool({
      cfg: context.getRuntimeConfig(),
      toolName: params.name,
      args: params.args,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      confirm: params.confirm === true,
      idempotencyKey: params.idempotencyKey,
      senderIsOwner: Array.isArray(client?.connect?.scopes)
        ? client.connect.scopes.includes(ADMIN_SCOPE)
        : false,
      surface: "http",
    });

    if (!result.body.ok && result.body.error.type === "invalid_request") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.body.error.message));
      return;
    }
    respond(true, result.body, undefined);
  },
};

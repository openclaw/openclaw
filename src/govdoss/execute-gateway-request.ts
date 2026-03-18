import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { govdossGatewayGuard } from "./gateway-guard.js";
import type { GatewayRequestHandlers, GatewayRequestOptions } from "../gateway/server-methods/types.js";

export async function executeGatewayRequestWithGovdoss(params: {
  req: GatewayRequestOptions["req"];
  respond: GatewayRequestOptions["respond"];
  client: GatewayRequestOptions["client"];
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
  context: GatewayRequestOptions["context"];
  handler: NonNullable<GatewayRequestHandlers[string]>;
}): Promise<void> {
  const { req, respond, client, isWebchatConnect, context, handler } = params;

  const invokeHandler = () =>
    handler({
      req,
      params: (req.params ?? {}) as Record<string, unknown>,
      client,
      isWebchatConnect,
      respond,
      context,
    });

  await withPluginRuntimeGatewayRequestScope({ context, client, isWebchatConnect }, async () => {
    const result = await govdossGatewayGuard.execute({
      req,
      client,
      context,
      executor: invokeHandler,
    });

    if (result.status === "approval-required") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `approval required for ${req.method}`, {
          retryable: true,
          details: {
            code: "APPROVAL_REQUIRED",
            approvalRequest: result.approvalRequest,
            continuation: result.continuation,
            decision: result.decision,
          },
        }),
      );
    }
  });
}

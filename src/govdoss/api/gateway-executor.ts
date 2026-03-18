import { coreGatewayHandlers } from "../../gateway/server-methods.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
} from "../../gateway/server-methods/types.js";
import type { ConnectParams, RequestFrame } from "../../gateway/protocol/index.js";
import { executeGatewayRequestWithGovdoss } from "../execute-gateway-request.js";
import type { GovdossApiPrincipal } from "./auth.js";
import type { GovdossTenantContext } from "../tenant-context.js";

export type GovdossGatewayAdapter = {
  getContext: () => GatewayRequestContext;
  getHandler?: (method: string) => GatewayRequestHandler | null;
};

export type GovdossGatewayExecutionResult = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
  meta?: Record<string, unknown>;
};

function buildApiClient(principal: GovdossApiPrincipal): GatewayClient {
  const connect: ConnectParams = {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "govdoss-api",
      displayName: principal.subject,
      version: "0.1.0",
      mode: "cli",
    },
    role: "operator",
    scopes: principal.scopes,
  };
  return {
    connect,
    connId: `govdoss-${principal.apiKeyId}`,
  };
}

function buildRequestFrame(method: string, params?: Record<string, unknown>): RequestFrame {
  return {
    type: "req",
    id: `govdoss-${Date.now()}`,
    method,
    params: params ?? {},
  };
}

export async function executeGovdossMethodViaGateway(input: {
  principal: GovdossApiPrincipal;
  tenant: GovdossTenantContext;
  method: string;
  params?: Record<string, unknown>;
  adapter: GovdossGatewayAdapter;
}): Promise<GovdossGatewayExecutionResult> {
  const client = buildApiClient(input.principal);
  const req = buildRequestFrame(input.method, input.params);
  const handler = input.adapter.getHandler?.(input.method) ?? coreGatewayHandlers[input.method];

  if (!handler) {
    return {
      ok: false,
      error: { code: "UNKNOWN_METHOD", message: `unknown method: ${input.method}` },
    };
  }

  const context = input.adapter.getContext();
  let result: GovdossGatewayExecutionResult = { ok: false, error: { message: "no response" } };

  const respond = (
    ok: boolean,
    payload?: unknown,
    error?: unknown,
    meta?: Record<string, unknown>,
  ) => {
    result = { ok, payload, error, meta };
  };

  await executeGatewayRequestWithGovdoss({
    req,
    respond,
    client,
    isWebchatConnect: () => false,
    context,
    handler,
  });

  return result;
}

/** Server identity advertised by the Gateway-hosted MCP loopback endpoint. */
export const MCP_LOOPBACK_SERVER_NAME = "openclaw";
/** MCP loopback server version reported during initialize negotiation. */
export const MCP_LOOPBACK_SERVER_VERSION = "0.1.0";
/** Protocol versions supported by the loopback endpoint, ordered by preference. */
export const MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;

type JsonRpcId = string | number | null | undefined;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

/** Builds a JSON-RPC 2.0 success response, normalizing notifications/missing ids to null. */
export function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

/** Builds a JSON-RPC 2.0 error response for MCP loopback handlers. */
export function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

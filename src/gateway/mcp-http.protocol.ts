type JsonRpcId = string | number | null | undefined;

/** MCP server identity advertised during the loopback initialize handshake. */
export const MCP_LOOPBACK_SERVER_NAME = "openclaw";
/** MCP server version advertised to local loopback clients. */
export const MCP_LOOPBACK_SERVER_VERSION = "0.1.0";
/** Protocol versions accepted from local MCP clients, newest first. */
export const MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;

/** Minimal JSON-RPC request shape accepted by the MCP loopback HTTP server. */
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

/** Builds a JSON-RPC success frame, preserving null ids for notifications/errors. */
export function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

/** Builds a JSON-RPC error frame with the caller-selected MCP error code. */
export function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

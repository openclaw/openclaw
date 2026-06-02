export const MCP_LOOPBACK_SERVER_NAME = "openclaw";
export const MCP_LOOPBACK_SERVER_VERSION = "0.1.0";
export const MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;

type JsonRpcId = string | number | null | undefined;

export type JsonRpcRequest = {
  /** JSON-RPC version accepted by the MCP loopback HTTP endpoint. */
  jsonrpc: "2.0";
  /** Caller-supplied correlation id; omitted ids are normalized in responses. */
  id?: JsonRpcId;
  /** MCP method name such as initialize, tools/list, or tools/call. */
  method: string;
  /** Method-specific params after JSON parsing, when the request supplies an object. */
  params?: Record<string, unknown>;
};

/**
 * Build a JSON-RPC success response for MCP loopback clients. Missing request
 * ids normalize to null so notifications and malformed callers get a stable
 * response shape at this HTTP boundary.
 */
export function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

/** Build a JSON-RPC error response for MCP loopback clients. */
export function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

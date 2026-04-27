export const MCP_LOOPBACK_SERVER_NAME = "openclaw";
export const MCP_LOOPBACK_SERVER_VERSION = "0.1.0";
export const MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];
export function jsonRpcResult(id, result) {
    return { jsonrpc: "2.0", id: id ?? null, result };
}
export function jsonRpcError(id, code, message) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

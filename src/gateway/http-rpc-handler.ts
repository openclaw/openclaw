import type { IncomingMessage, ServerResponse } from "node:http";
import { handleGatewayRequest } from "./server-methods.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { ResolvedGatewayAuth } from "./auth.js";
import { AuthRateLimiter } from "./auth-rate-limit.js";
import { sendJson } from "./http-common.js";
import { authorizeGatewayHttpRequestOrReply, resolveTrustedHttpOperatorScopes } from "./http-utils.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { GATEWAY_CLIENT_MODES } from "../utils/message-channel.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { getFallbackGatewayContextForHttpRpc } from "./server-plugins.js";

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: unknown;
  id?: string | number | null;
}

interface JsonRpcSuccessResponse {
  jsonrpc: string;
  result: unknown;
  id: string | number | null;
}

interface JsonRpcErrorResponse {
  jsonrpc: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: string | number | null;
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

function isValidJsonRpcRequest(body: unknown): body is JsonRpcRequest {
  if (!body || typeof body !== "object") {
    return false;
  }
  
  const request = body as Partial<JsonRpcRequest>;
  return (
    request.jsonrpc === "2.0" &&
    typeof request.method === "string" &&
    (request.id === undefined || 
     request.id === null || 
     typeof request.id === "string" || 
     typeof request.id === "number")
  );
}

function createJsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    error: {
      code,
      message,
      data
    },
    id: id ?? null
  };
}

function createJsonRpcSuccess(
  id: string | number | null | undefined,
  result: unknown
): JsonRpcSuccessResponse {
  return {
    jsonrpc: "2.0",
    result,
    id: id ?? null
  };
}

const MAX_RPC_BODY_BYTES = 1024 * 1024; // 1MB max

export async function handleHttpRpcEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  auth: ResolvedGatewayAuth,
  rateLimiter?: AuthRateLimiter
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  
  // Check if this is an RPC request
  if (url.pathname !== "/rpc") {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    sendJson(res, 405, {
      error: { message: "Method Not Allowed", type: "method_not_allowed" },
    });
    return true;
  }

  // Enforce authentication
  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth,
    rateLimiter,
  });
  if (!requestAuth) {
    return true; // Response already sent by authorizeGatewayHttpRequestOrReply
  }

  // Parse request body
  let body: unknown;
  try {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    for await (const chunk of req) {
      const bufferChunk = chunk as Buffer;
      totalLength += bufferChunk.length;
      
      // Check size limit
      if (totalLength > MAX_RPC_BODY_BYTES) {
        sendJson(res, 413, createJsonRpcError(undefined, -32600, "Invalid Request: Request body too large"));
        return true;
      }
      
      chunks.push(bufferChunk);
    }
    
    const bodyStr = Buffer.concat(chunks).toString("utf8");
    if (!bodyStr.trim()) {
      sendJson(res, 400, createJsonRpcError(undefined, -32700, "Parse error: Empty request body"));
      return true;
    }
    
    body = JSON.parse(bodyStr);
  } catch (err) {
    sendJson(res, 400, createJsonRpcError(undefined, -32700, `Parse error: ${(err as Error).message}`));
    return true;
  }

  // Get the real gateway context
  const context = getFallbackGatewayContextForHttpRpc();
  if (!context) {
    sendJson(res, 500, createJsonRpcError(undefined, -32603, "Internal error: Gateway context not available"));
    return true;
  }

  // Validate JSON-RPC 2.0 format
  if (Array.isArray(body)) {
    // Batch request - for simplicity in this implementation, we'll handle sequentially
    if (body.length === 0) {
      // JSON-RPC 2.0 spec: empty batch requests should return Invalid Request error
      sendJson(res, 400, createJsonRpcError(undefined, -32600, "Invalid Request: Empty batch"));
      return true;
    }
    
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      if (!isValidJsonRpcRequest(item)) {
        responses.push(createJsonRpcError(undefined, -32600, "Invalid Request: Malformed request"));
        continue;
      }
      
      const response = await handleSingleRequest(item, auth, context, requestAuth);
      if (item.id !== undefined && item.id !== null) { // Only include response if request had an id (notifications don't get responses)
        responses.push(response);
      }
    }
    
    // Only send response if there are responses to return (batch notifications return empty array)
    if (responses.length > 0) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(responses));
    } else {
      // For batch notifications, return empty response body with 200 status
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end("[]");
    }
    return true;
  } else {
    // Single request
    if (!isValidJsonRpcRequest(body)) {
      sendJson(res, 400, createJsonRpcError(undefined, -32600, "Invalid Request: Malformed request"));
      return true;
    }

    const response = await handleSingleRequest(body, auth, context, requestAuth);
    
    // For notifications (requests without id), don't return a response
    if (body.id === undefined || body.id === null) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(); // No body for notifications
    } else {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(response));
    }
    return true;
  }
}

async function handleSingleRequest(
  request: JsonRpcRequest,
  auth: ResolvedGatewayAuth,
  context: GatewayRequestContext,
  requestAuth: Awaited<ReturnType<typeof authorizeGatewayHttpRequestOrReply>>
): Promise<JsonRpcResponse> {
  // Create a client with appropriate scopes based on the auth
  // For authenticated requests, use default operator scopes; for unauthenticated requests, use no scopes
  const client = {
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      scopes: requestAuth ? ["operator.read", "operator.write"] : [],
      client: {
        id: "http-rpc", // Using a custom client ID for HTTP RPC
        version: "1.0.0",
        platform: "http",
        mode: GATEWAY_CLIENT_MODES.BACKEND // Using BACKEND mode since there isn't a specific HTTP mode
      },
      role: "operator" as const
    }
  };

  return new Promise<JsonRpcResponse>((resolve) => {
    // Prepare the response handler
    const respond = (
      ok: boolean,
      payload: unknown,
      errorObj: { code?: string; message?: string; details?: unknown } | undefined
    ) => {
      if (ok) {
        resolve(createJsonRpcSuccess(request.id, payload));
      } else {
        // Map gateway error codes to JSON-RPC codes
        let errorCode = -32603; // Internal error by default
        if (errorObj?.code === "INVALID_REQUEST") {
          errorCode = -32600; // Invalid Request
        } else if (errorObj?.code === "METHOD_NOT_FOUND") {
          errorCode = -32601; // Method not found
        } else if (errorObj?.code === "PARSE_ERROR") {
          errorCode = -32700; // Parse error
        }
        
        const errorMessage = errorObj?.message || "Internal error";
        resolve(createJsonRpcError(request.id, errorCode, errorMessage, errorObj?.details));
      }
    };

    // Call the gateway handler with the real context
    handleGatewayRequest({
      req: {
        type: "req",
        id: request.id ? String(request.id) : "http-rpc-" + Date.now(),
        method: request.method,
        params: request.params,
      },
      respond,
      client,
      isWebchatConnect: () => false,
      context,
      extraHandlers: coreGatewayHandlers
    }).catch((err) => {
      console.error("Error handling HTTP RPC request:", err);
      resolve(createJsonRpcError(request.id, -32603, `Internal error: ${err.message}`));
    });
  });
}

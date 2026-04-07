import type { IncomingMessage, ServerResponse } from "node:http";
import { handleGatewayRequest } from "./server-methods.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { ResolvedGatewayAuth } from "./auth.js";
import { AuthRateLimiter } from "./auth-rate-limit.js";
import { sendJson } from "./http-common.js";
import { loadConfig } from "../config/config.js";
import { createDeduplicateSequence } from "./deduplicate-sequence.js";
import { createAgentEventHandler } from "./server-chat.js";
import { createSessionEventSubscriberRegistry } from "./server-chat.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat.js";
import { NodeRegistry } from "./node-registry.js";
import { createChannelManager } from "./server-channels.js";
import { buildGatewayCronService } from "./server-cron.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createDefaultDeps } from "../cli/deps.js";
import { createGatewayCloseHandler } from "./server-close.js";
import { startGatewayModelPricingRefresh } from "./model-pricing-cache.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import { startTaskRegistryMaintenance } from "../tasks/task-registry.maintenance.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import { GATEWAY_CLIENT_MODES } from "../utils/message-channel.js";
import { ErrorCodes } from "./protocol/index.js";

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

  // Parse request body
  let body: unknown;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
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

  // Validate JSON-RPC 2.0 format
  if (Array.isArray(body)) {
    // Batch request - for simplicity in this implementation, we'll handle sequentially
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      if (!isValidJsonRpcRequest(item)) {
        responses.push(createJsonRpcError(undefined, -32600, "Invalid Request: Malformed request"));
        continue;
      }
      
      const response = await handleSingleRequest(item, auth, rateLimiter);
      if (item.id !== undefined) { // Only include response if request had an id (notifications don't get responses)
        responses.push(response);
      }
    }
    
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(responses));
    return true;
  } else {
    // Single request
    if (!isValidJsonRpcRequest(body)) {
      sendJson(res, 400, createJsonRpcError(undefined, -32600, "Invalid Request: Malformed request"));
      return true;
    }

    const response = await handleSingleRequest(body, auth, rateLimiter);
    
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(response));
    return true;
  }
}

async function handleSingleRequest(
  request: JsonRpcRequest,
  auth: ResolvedGatewayAuth,
  rateLimiter?: AuthRateLimiter
): Promise<JsonRpcResponse> {
  // Create a minimal gateway request context
  // This is a simplified version - in a production implementation, 
  // you'd want to properly initialize all required dependencies
  const config = loadConfig();
  
  // Create a mock client with appropriate scopes based on the auth
  const client = {
    connect: {
      scopes: ["operator.read", "operator.write"], // Scopes determined by auth
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
    // Create a minimal context - in a real implementation, you'd need to 
    // properly initialize all the required services and state
    const deps = createMinimalDeps();
    
    // Create a minimal request context
    const context = createMinimalRequestContext(deps);

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

    // Call the gateway handler
    handleGatewayRequest({
      req: {
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

// Create a minimal set of dependencies for the HTTP RPC handler
function createMinimalDeps() {
  // This creates minimal stubs for dependencies
  // In a real implementation, you'd want to properly initialize these
  return createDefaultDeps();
}

// Create a minimal request context
function createMinimalRequestContext(deps: ReturnType<typeof createDefaultDeps>): GatewayRequestContext {
  // Creating a minimal context with stub implementations
  // This is a simplified version for HTTP RPC - in production you'd want complete implementations
  const execApproval = new ExecApprovalManager({} as any);
  return {
    deps,
    cron: buildGatewayCronService({} as any, {} as any),
    cronStorePath: "",
    execApprovalManager: execApproval,
    pluginApprovalManager: execApproval,
    loadGatewayModelCatalog: () => Promise.resolve([]),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({ ok: true }),
    logHealth: { error: console.error },
    logGateway: {
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug
    },
    incrementPresenceVersion: () => 0,
    getHealthVersion: () => 0,
    broadcast: () => {},
    broadcastToConnIds: () => {},
    nodeSendToSession: () => {},
    nodeSendToAllSubscribed: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    nodeUnsubscribeAll: () => {},
    hasConnectedMobileNode: () => false,
    hasExecApprovalClients: undefined,
    disconnectClientsForDevice: undefined,
    nodeRegistry: new NodeRegistry(),
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    addChatRun: () => {},
    removeChatRun: () => undefined,
    subscribeSessionEvents: () => {},
    unsubscribeSessionEvents: () => {},
    subscribeSessionMessageEvents: () => {},
    unsubscribeSessionMessageEvents: () => {},
    unsubscribeAllSessionEvents: () => {},
    getSessionEventSubscriberConnIds: () => new Set(),
    registerToolEventRecipient: () => {},
    dedupe: new Map(),
    wizardSessions: new Map(),
    findRunningWizard: () => null,
    purgeWizardSession: () => {},
    getRuntimeSnapshot: () => ({} as any),
    startChannel: async () => {},
    stopChannel: async () => {},
    markChannelLoggedOut: () => {},
    wizardRunner: async () => {},
    broadcastVoiceWakeChanged: () => {},
  };
}

import { ErrorCodes } from "./protocol/index.js";
import { handleBridgeEvent as handleBridgeEventImpl } from "./server-bridge-events.js";
import { handleChatBridgeMethods } from "./server-bridge-methods-chat.js";
import { handleConfigBridgeMethods } from "./server-bridge-methods-config.js";
import { handleSessionsBridgeMethods } from "./server-bridge-methods-sessions.js";
import { handleSystemBridgeMethods } from "./server-bridge-methods-system.js";
import type {
  BridgeEvent,
  BridgeHandlersContext,
  BridgeRequest,
  BridgeResponse,
} from "./server-bridge-types.js";

export type { BridgeHandlersContext } from "./server-bridge-types.js";

export function createBridgeHandlers(ctx: BridgeHandlersContext) {
  const handleBridgeRequest = async (
    nodeId: string,
    req: BridgeRequest,
  ): Promise<BridgeResponse> => {
    const method = req.method.trim();

    const parseParams = (): Record<string, unknown> => {
      const raw = typeof req.paramsJSON === "string" ? req.paramsJSON : "";
      const trimmed = raw.trim();
      if (!trimmed) return {};
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    };

    try {
      const params = parseParams();
      const response =
        (await handleSystemBridgeMethods(ctx, nodeId, method, params)) ??
        (await handleConfigBridgeMethods(ctx, nodeId, method, params)) ??
        (await handleSessionsBridgeMethods(ctx, nodeId, method, params)) ??
        (await handleChatBridgeMethods(ctx, nodeId, method, params));
      if (response) return response;
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Method not allowed",
          details: { method },
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: { code: ErrorCodes.INVALID_REQUEST, message: String(err) },
      };
    }
  };

  const handleBridgeEvent = async (nodeId: string, evt: BridgeEvent) => {
    await handleBridgeEventImpl(ctx, nodeId, evt);
  };

  return { handleBridgeRequest, handleBridgeEvent };
}

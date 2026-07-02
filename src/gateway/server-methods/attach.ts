import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { resolveSessionEntryChatType } from "../../sessions/session-chat-type-shared.js";
import { resolveLongTermMemoryDefaultPolicy } from "../../sessions/session-memory-policy.js";
import { mintAttachGrant, revokeAttachGrant } from "../mcp-grant-store.js";
import { ensureMcpLoopbackServer } from "../mcp-http.js";
import {
  createMcpAttachGrantServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../mcp-http.loopback-runtime.js";
import { loadSessionEntry } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

function paramRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveGrantScope(sessionKey: string) {
  const loaded = loadSessionEntry(sessionKey, { strictRead: true });
  const canonicalSessionKey = loaded.canonicalKey;
  const chatType = resolveSessionEntryChatType(loaded.entry);
  const longTermMemoryDefaultPolicy = loaded.entry?.longTermMemoryDefaultPolicy;
  const policy = resolveLongTermMemoryDefaultPolicy({
    sessionKey: canonicalSessionKey,
    chatType,
    longTermMemoryDefaultPolicy,
  });
  if (policy === "explicit-only") {
    return {
      sessionKey: canonicalSessionKey,
      chatType: chatType === "group" || chatType === "channel" ? chatType : "group",
    };
  }
  return {
    sessionKey: canonicalSessionKey,
    chatType,
  };
}

export const attachHandlers: GatewayRequestHandlers = {
  "attach.grant": async ({ params, respond, context }) => {
    const grantParams = paramRecord(params);
    await ensureMcpLoopbackServer();
    const runtime = getActiveMcpLoopbackRuntime();
    if (!runtime) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "mcp loopback server unavailable"),
      );
      return;
    }
    const sessionKey =
      readString(grantParams, "sessionKey") ?? resolveMainSessionKey(context.getRuntimeConfig());
    let grantScope: ReturnType<typeof resolveGrantScope>;
    try {
      grantScope = resolveGrantScope(sessionKey);
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "session policy unavailable"));
      return;
    }
    const grant = mintAttachGrant({
      sessionKey: grantScope.sessionKey,
      ...(grantScope.chatType ? { chatType: grantScope.chatType } : {}),
      ttlMs: readPositiveNumber(grantParams, "ttlMs"),
    });
    respond(true, {
      sessionKey: grant.sessionKey,
      token: grant.token,
      expiresAtMs: grant.expiresAtMs,
      mcpConfig: createMcpAttachGrantServerConfig(runtime.port),
      env: {
        OPENCLAW_MCP_TOKEN: grant.token,
      },
    });
  },
  "attach.revoke": async ({ params, respond }) => {
    const token = readString(paramRecord(params), "token");
    if (!token) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "token is required"));
      return;
    }
    respond(true, { revoked: revokeAttachGrant(token) });
  },
};

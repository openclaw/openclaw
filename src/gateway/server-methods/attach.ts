// Gateway RPC handlers for attach grants: mint a per-session, scoped, revocable MCP loopback grant
// so an external/interactive harness can reach the gateway's scoped tools, and revoke it on detach.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { mintAttachGrant, revokeAttachGrant } from "../mcp-grant-store.js";
import { ensureMcpLoopbackServer } from "../mcp-http.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../mcp-http.loopback-runtime.js";
import type { GatewayRequestHandlers } from "./types.js";

function paramRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

function readString(params: unknown, key: string): string | undefined {
  const value = paramRecord(params)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(params: unknown, key: string): number | undefined {
  const value = paramRecord(params)[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export const attachHandlers: GatewayRequestHandlers = {
  // Mint a grant bound to a session, returning the loopback MCP config + the token env the harness
  // needs. ensureMcpLoopbackServer lazily brings the singleton up if no cli-backend turn started it.
  "attach.grant": async ({ params, respond, context }) => {
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
      readString(params, "sessionKey") ?? resolveMainSessionKey(context.getRuntimeConfig());
    const grant = mintAttachGrant({ sessionKey, ttlMs: readPositiveNumber(params, "ttlMs") });
    respond(true, {
      sessionKey: grant.sessionKey,
      token: grant.token,
      expiresAtMs: grant.expiresAtMs,
      // The harness writes mcpConfig to its MCP client config and sets env so the ${...} placeholders
      // resolve. Loopback today; node/app conduits reuse the same client config over their channel.
      mcpConfig: createMcpLoopbackServerConfig(runtime.port),
      env: {
        OPENCLAW_MCP_TOKEN: grant.token,
        OPENCLAW_MCP_SESSION_KEY: grant.sessionKey,
      },
    });
  },
  // Revoke a previously minted grant. Idempotent: an unknown/already-expired token reports revoked=false.
  "attach.revoke": async ({ params, respond }) => {
    const token = readString(params, "token");
    if (!token) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "token is required"));
      return;
    }
    respond(true, { revoked: revokeAttachGrant(token) });
  },
};

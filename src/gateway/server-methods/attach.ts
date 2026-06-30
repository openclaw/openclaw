// Gateway RPC handlers for attach grants: mint a per-session, scoped, revocable MCP loopback grant
// so an external/interactive harness can reach the gateway's scoped tools, and revoke it on detach.
import { randomUUID } from "node:crypto";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { hashCliSessionText, setCliSessionBinding } from "../../agents/cli-session.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { loadSessionEntry, patchSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { CLAUDE_CLI_PROVIDER } from "../cli-session-history.claude.js";
import { mintAttachGrant, resolveAttachGrant, revokeAttachGrant } from "../mcp-grant-store.js";
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
    // resumeSessionId: the bound Claude cli session — but only when it was created in THIS cwd. Claude
    // scopes sessions per project, so `claude --resume <id>` from another cwd would fail ("No
    // conversation found"); the cwdHash gate matches the cli-backend's cwd-invalidation (cli-session.ts)
    // and is robust cross-platform (hashCliSessionText), unlike re-deriving Claude's project-dir name.
    const binding = loadSessionEntry({ sessionKey })?.cliSessionBindings?.[CLAUDE_CLI_PROVIDER];
    const resumeSessionId =
      binding?.sessionId && binding.cwdHash === hashCliSessionText(readString(params, "cwd"))
        ? binding.sessionId
        : undefined;
    respond(true, {
      sessionKey: grant.sessionKey,
      token: grant.token,
      expiresAtMs: grant.expiresAtMs,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      // The harness writes mcpConfig to its MCP client config and sets env so the ${...} placeholders
      // resolve. Loopback today; node/app conduits reuse the same client config over their channel.
      mcpConfig: createMcpLoopbackServerConfig(runtime.port),
      env: {
        OPENCLAW_MCP_TOKEN: grant.token,
        OPENCLAW_MCP_SESSION_KEY: grant.sessionKey,
      },
    });
  },
  // Adopt the harness's Claude cli session (id known up-front via `claude --session-id <uuid>`) into
  // the granted gateway session: persist the {sessionKey ↔ cliSessionId} binding so the conversation
  // is recorded (history import) and resumable on the next attach. Bound to the grant, not headers.
  "attach.adopt": async ({ params, respond }) => {
    const token = readString(params, "token");
    const cliSessionId = readString(params, "cliSessionId");
    if (!token || !cliSessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "token and cliSessionId are required"),
      );
      return;
    }
    const grant = resolveAttachGrant(token);
    if (!grant) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired grant"));
      return;
    }
    // Persist the binding with an ATOMIC read-modify-write: patchSessionEntry runs the mutator on the
    // entry loaded inside the store transaction, so setCliSessionBinding's `...existing` spread
    // preserves other providers' bindings without a TOCTOU race. fallbackEntry creates the session if
    // it does not exist yet (otherwise the binding silently drops for a session adopted before its
    // first turn, breaking resume); it carries the binding so the create path persists it too.
    // Record the adopting cwd's hash on the binding so a later grant only resumes from the same cwd
    // (Claude scopes sessions per project) — mirrors the cli-backend's cwdHash invalidation.
    const cwdHash = hashCliSessionText(readString(params, "cwd"));
    const binding = { sessionId: cliSessionId, ...(cwdHash ? { cwdHash } : {}) };
    const fallbackEntry: SessionEntry = { sessionId: randomUUID(), updatedAt: Date.now() };
    setCliSessionBinding(fallbackEntry, CLAUDE_CLI_PROVIDER, binding);
    const persisted = await patchSessionEntry(
      { sessionKey: grant.sessionKey },
      (entry) => {
        setCliSessionBinding(entry, CLAUDE_CLI_PROVIDER, binding);
        return entry;
      },
      { fallbackEntry },
    );
    respond(true, { sessionKey: grant.sessionKey, cliSessionId, persisted: persisted !== null });
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

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { SAFE_SESSION_ID_RE } from "../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
  sendInvalidRequest,
  setSseHeaders,
  writeDone,
} from "../gateway/http-common.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { authenticateTenantRequest, type TenantContext } from "./tenant-auth.js";
import { resolveTenantSessionsDir } from "./tenant-paths.js";

// ── Types ──────────────────────────────────────────────────────────

type ChatRequest = {
  message?: string;
  session_id?: string;
  model?: string;
  stream?: boolean;
  system_prompt?: string;
  thinking?: string;
};

// ── SSE helpers ────────────────────────────────────────────────────

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Route matching ─────────────────────────────────────────────────

const CHAT_PATH = "/api/v1/chat";
const SESSIONS_PATH = "/api/v1/sessions";

// ── Chat handler ───────────────────────────────────────────────────

/**
 * Handle tenant chat and session endpoints.
 *
 * Routes:
 *   POST   /api/v1/chat              → Send message
 *   GET    /api/v1/sessions          → List sessions
 *   DELETE /api/v1/sessions/:id      → Delete session
 */
export async function handleTenantChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === CHAT_PATH) {
    return await handleChat(req, res);
  }
  if (pathname === SESSIONS_PATH || pathname.startsWith(`${SESSIONS_PATH}/`)) {
    return await handleSessions(req, res, pathname);
  }

  return false;
}

// ── POST /api/v1/chat ──────────────────────────────────────────────

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const tenant = await authenticateTenantRequest(req);
  if (!tenant) {
    sendUnauthorized(res);
    return true;
  }

  const body = await readJsonBodyOrError(req, res, 1024 * 1024);
  if (body === undefined) {
    return true;
  }

  const payload = body as ChatRequest;
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) {
    sendInvalidRequest(res, "Missing required field: message");
    return true;
  }

  const stream = Boolean(payload.stream);
  const sessionId =
    typeof payload.session_id === "string" ? payload.session_id.trim() : randomUUID();

  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    sendInvalidRequest(res, "Invalid session_id: must match /^[a-z0-9][a-z0-9._-]{0,127}$/i");
    return true;
  }

  const sessionKey = buildAgentMainSessionKey({
    agentId: tenant.agentId,
    mainKey: `api:${sessionId}`,
  });

  const runId = `tenant_${randomUUID()}`;
  const deps = createDefaultDeps();

  const commandOpts = {
    message,
    extraSystemPrompt:
      typeof payload.system_prompt === "string" ? payload.system_prompt : undefined,
    sessionKey,
    runId,
    deliver: false,
    messageChannel: "api" as const,
    bestEffortDeliver: false,
    thinking: typeof payload.thinking === "string" ? payload.thinking : undefined,
  };

  if (!stream) {
    return await handleSyncChat(res, tenant, commandOpts, runId, sessionId, deps);
  }
  return handleStreamChat(req, res, tenant, commandOpts, runId, sessionId, deps);
}

// ── Sync chat ──────────────────────────────────────────────────────

async function handleSyncChat(
  res: ServerResponse,
  _tenant: TenantContext,
  commandOpts: Parameters<typeof agentCommand>[0],
  runId: string,
  sessionId: string,
  deps: ReturnType<typeof createDefaultDeps>,
): Promise<boolean> {
  try {
    const result = await agentCommand(commandOpts, defaultRuntime, deps);

    const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
    const content =
      Array.isArray(payloads) && payloads.length > 0
        ? payloads
            .map((p) => (typeof p.text === "string" ? p.text : ""))
            .filter(Boolean)
            .join("\n\n")
        : "No response.";

    sendJson(res, 200, {
      id: runId,
      session_id: sessionId,
      message: { role: "assistant", content },
      usage: { input_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    sendJson(res, 500, {
      error: { message: String(err), type: "server_error" },
    });
  }
  return true;
}

// ── Streaming chat ─────────────────────────────────────────────────

function handleStreamChat(
  req: IncomingMessage,
  res: ServerResponse,
  _tenant: TenantContext,
  commandOpts: Parameters<typeof agentCommand>[0],
  runId: string,
  sessionId: string,
  deps: ReturnType<typeof createDefaultDeps>,
): boolean {
  setSseHeaders(res);

  let closed = false;

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId || closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const delta = evt.data?.delta;
      const text = evt.data?.text;
      const content = typeof delta === "string" ? delta : typeof text === "string" ? text : "";
      if (content) {
        writeSse(res, { id: runId, event: "delta", content });
      }
      return;
    }

    if (evt.stream === "thinking") {
      const delta = evt.data?.delta;
      if (typeof delta === "string" && delta) {
        writeSse(res, { id: runId, event: "thinking", content: delta });
      }
      return;
    }

    if (evt.stream === "tool") {
      const phase = evt.data?.phase;
      const name = evt.data?.name;
      if (phase === "start" && name) {
        writeSse(res, {
          id: runId,
          event: "tool_use",
          name,
          args: evt.data?.args,
        });
      } else if (phase === "result" && name) {
        writeSse(res, {
          id: runId,
          event: "tool_result",
          name,
          result: evt.data?.result,
          is_error: Boolean(evt.data?.isError),
        });
      }
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        closed = true;
        unsubscribe();
        writeSse(res, { id: runId, event: "done", session_id: sessionId });
        writeDone(res);
        res.end();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      await agentCommand(commandOpts, defaultRuntime, deps);

      if (!closed) {
        closed = true;
        unsubscribe();
        writeSse(res, { id: runId, event: "done", session_id: sessionId });
        writeDone(res);
        res.end();
      }
    } catch (err) {
      if (!closed) {
        closed = true;
        unsubscribe();
        writeSse(res, {
          id: runId,
          event: "error",
          message: String(err),
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "error" },
        });
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}

// ── Session management ─────────────────────────────────────────────

async function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const tenant = await authenticateTenantRequest(req);
  if (!tenant) {
    sendUnauthorized(res);
    return true;
  }

  // GET /api/v1/sessions — list sessions
  if (pathname === SESSIONS_PATH && req.method === "GET") {
    return await handleListSessions(res, tenant);
  }

  // DELETE /api/v1/sessions/:id — delete session
  const sessionId = pathname.slice(SESSIONS_PATH.length + 1);
  if (sessionId && req.method === "DELETE") {
    return await handleDeleteSession(res, tenant, sessionId);
  }

  sendMethodNotAllowed(res, pathname === SESSIONS_PATH ? "GET" : "DELETE");
  return true;
}

async function handleListSessions(res: ServerResponse, tenant: TenantContext): Promise<boolean> {
  try {
    const sessionsDir = resolveTenantSessionsDir(tenant.tenantId);
    const storePath = `${sessionsDir}/sessions.json`;
    const store = loadSessionStore(storePath);

    const sessions = Object.entries(store).map(([key, entry]) => ({
      session_id: entry?.sessionId ?? key,
      session_key: key,
      updated_at: entry?.updatedAt ? new Date(entry.updatedAt).toISOString() : undefined,
      model: entry?.model,
    }));

    sendJson(res, 200, { sessions });
  } catch {
    sendJson(res, 200, { sessions: [] });
  }
  return true;
}

async function handleDeleteSession(
  res: ServerResponse,
  tenant: TenantContext,
  sessionId: string,
): Promise<boolean> {
  try {
    const sessionsDir = resolveTenantSessionsDir(tenant.tenantId);
    const storePath = `${sessionsDir}/sessions.json`;

    let found = false;
    await updateSessionStore(storePath, (store) => {
      // Find the session key whose entry.sessionId matches, or whose key matches directly
      for (const key of Object.keys(store)) {
        const entry = store[key];
        if (key === sessionId || entry?.sessionId === sessionId) {
          delete store[key];
          found = true;
          break;
        }
      }
    });

    sendJson(res, 200, { session_id: sessionId, deleted: found });
  } catch {
    sendJson(res, 200, { session_id: sessionId, deleted: false });
  }
  return true;
}

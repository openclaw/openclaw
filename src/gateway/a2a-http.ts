/**
 * A2A (Agent-to-Agent) Protocol HTTP handler.
 *
 * Exposes two HTTP endpoints:
 *   GET  /.well-known/agent.json  — Agent Card discovery
 *   POST /a2a                     — JSON-RPC 2.0 task handling
 *
 * @see https://a2a-protocol.org/latest/specification/
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { listAgentEntries } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { logDebug, logError } from "../logger.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import { buildAgentCard } from "./a2a-agent-card.js";
import { resolveSecretValue } from "../config/secrets.js";

// ── Types ────────────────────────────────────────────────────────────────────

type A2aTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

type A2aTaskStatus = {
  state: A2aTaskState;
  timestamp: string;
  message?: { role: string; parts: Array<{ type: string; text: string }> };
};

type A2aTask = {
  id: string;
  contextId?: string;
  status: A2aTaskStatus;
  artifacts?: Array<{
    parts: Array<{ type: string; text: string }>;
  }>;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// ── In-memory task store ─────────────────────────────────────────────────────

const taskStore = new Map<string, A2aTask>();

const MAX_TASKS = 1000;
const TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes

function pruneOldTasks(): void {
  if (taskStore.size <= MAX_TASKS) {
    return;
  }
  const now = Date.now();
  for (const [id, task] of taskStore) {
    if (now - new Date(task.status.timestamp).getTime() > TASK_TTL_MS) {
      taskStore.delete(id);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

async function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function authorizeA2aRequest(req: IncomingMessage): boolean {
  const cfg = loadConfig();
  const a2aAuth = cfg.gateway?.a2a?.auth;

  // No auth configured — allow all requests.
  if (!a2aAuth?.apiKey && !a2aAuth?.bearerTokens) {
    return true;
  }

  // Check API key header.
  if (a2aAuth.apiKey) {
    const expected = resolveSecretValue(a2aAuth.apiKey);
    const provided = req.headers["x-api-key"];
    if (typeof provided === "string" && typeof expected === "string" && provided === expected) {
      return true;
    }
  }

  // Check Bearer token.
  if (a2aAuth.bearerTokens) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      // Accept any non-empty bearer token when bearerTokens is enabled.
      // A production deployment would validate against an OAuth2 provider.
      return authHeader.length > "Bearer ".length;
    }
  }

  return false;
}

// ── Agent Card endpoint ──────────────────────────────────────────────────────

export function handleA2aAgentCardRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/.well-known/agent.json") {
    return false;
  }

  const cfg = loadConfig();
  if (!cfg.gateway?.a2a?.enabled) {
    sendJson(res, 404, { error: "A2A protocol is not enabled" });
    return true;
  }

  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers.host ?? "localhost";
  const gatewayUrl = `${proto}://${host}`;

  const card = buildAgentCard(cfg, gatewayUrl);

  res.setHeader("Cache-Control", "public, max-age=3600");
  sendJson(res, 200, card);
  return true;
}

// ── JSON-RPC endpoint ────────────────────────────────────────────────────────

export async function handleA2aJsonRpcRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/a2a") {
    return false;
  }

  const cfg = loadConfig();
  if (!cfg.gateway?.a2a?.enabled) {
    sendJson(res, 404, { error: "A2A protocol is not enabled" });
    return true;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  // Auth check.
  if (!authorizeA2aRequest(req)) {
    sendJson(res, 401, jsonRpcError(null, -32000, "Unauthorized"));
    return true;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, jsonRpcError(null, -32700, "Parse error"));
    return true;
  }

  let rpcReq: JsonRpcRequest;
  try {
    rpcReq = JSON.parse(body) as JsonRpcRequest;
  } catch {
    sendJson(res, 400, jsonRpcError(null, -32700, "Parse error"));
    return true;
  }

  if (rpcReq.jsonrpc !== "2.0" || typeof rpcReq.method !== "string") {
    sendJson(res, 400, jsonRpcError(rpcReq.id ?? null, -32600, "Invalid request"));
    return true;
  }

  const rpcId = rpcReq.id ?? null;

  try {
    let response: JsonRpcResponse;
    switch (rpcReq.method) {
      case "tasks/send":
        response = await handleTasksSend(cfg, rpcReq.params, rpcId);
        break;
      case "tasks/get":
        response = handleTasksGet(rpcReq.params, rpcId);
        break;
      case "tasks/cancel":
        response = handleTasksCancel(rpcReq.params, rpcId);
        break;
      default:
        response = jsonRpcError(rpcId, -32601, `Method not found: ${rpcReq.method}`);
    }
    sendJson(res, 200, response);
  } catch (err) {
    logError("A2A JSON-RPC handler error:", err);
    sendJson(res, 200, jsonRpcError(rpcId, -32603, "Internal error"));
  }

  return true;
}

// ── Method handlers ──────────────────────────────────────────────────────────

async function handleTasksSend(
  cfg: ReturnType<typeof loadConfig>,
  params: Record<string, unknown> | undefined,
  rpcId: string | number | null,
): Promise<JsonRpcResponse> {
  if (!params?.message || typeof params.message !== "object") {
    return jsonRpcError(rpcId, -32602, "Invalid params: message is required");
  }

  const message = params.message as { role?: string; parts?: Array<{ type?: string; text?: string }> };
  const parts = message.parts ?? [];
  const textParts = parts.filter((p) => p.type === "text" && typeof p.text === "string");
  const inputText = textParts.map((p) => p.text).join("\n");

  if (!inputText.trim()) {
    return jsonRpcError(rpcId, -32602, "Invalid params: message must contain text parts");
  }

  // Resolve target agent.
  const targetAgentId = cfg.gateway?.a2a?.targetAgentId;
  const agents = listAgentEntries(cfg);
  const targetAgent = targetAgentId
    ? agents.find((a) => a.id === targetAgentId)
    : agents.find((a) => a.default) ?? agents[0];

  if (!targetAgent) {
    return jsonRpcError(rpcId, -32603, "No target agent available");
  }

  const taskId = randomUUID();
  const contextId =
    typeof params.contextId === "string" ? params.contextId : randomUUID();
  const now = new Date().toISOString();

  const task: A2aTask = {
    id: taskId,
    contextId,
    status: { state: "working", timestamp: now },
  };
  taskStore.set(taskId, task);
  pruneOldTasks();

  logDebug(`[A2A] tasks/send taskId=${taskId} agent=${targetAgent.id} input="${inputText.slice(0, 80)}"`);

  // Dispatch to the agent and collect the response.
  try {
    const responseText = await dispatchToAgent(cfg, targetAgent.id, inputText);

    task.status = {
      state: "completed",
      timestamp: new Date().toISOString(),
      message: {
        role: "agent",
        parts: [{ type: "text", text: responseText }],
      },
    };
    task.artifacts = [
      {
        parts: [{ type: "text", text: responseText }],
      },
    ];
  } catch (err) {
    task.status = {
      state: "failed",
      timestamp: new Date().toISOString(),
      message: {
        role: "agent",
        parts: [
          {
            type: "text",
            text: err instanceof Error ? err.message : "Task execution failed",
          },
        ],
      },
    };
  }

  return jsonRpcResult(rpcId, task);
}

function handleTasksGet(
  params: Record<string, unknown> | undefined,
  rpcId: string | number | null,
): JsonRpcResponse {
  const taskId = typeof params?.id === "string" ? params.id : null;
  if (!taskId) {
    return jsonRpcError(rpcId, -32602, "Invalid params: id is required");
  }

  const task = taskStore.get(taskId);
  if (!task) {
    return jsonRpcError(rpcId, -32001, `Task not found: ${taskId}`);
  }

  return jsonRpcResult(rpcId, task);
}

function handleTasksCancel(
  params: Record<string, unknown> | undefined,
  rpcId: string | number | null,
): JsonRpcResponse {
  const taskId = typeof params?.id === "string" ? params.id : null;
  if (!taskId) {
    return jsonRpcError(rpcId, -32602, "Invalid params: id is required");
  }

  const task = taskStore.get(taskId);
  if (!task) {
    return jsonRpcError(rpcId, -32001, `Task not found: ${taskId}`);
  }

  if (task.status.state === "completed" || task.status.state === "failed") {
    return jsonRpcError(rpcId, -32002, `Task already in terminal state: ${task.status.state}`);
  }

  task.status = {
    state: "canceled",
    timestamp: new Date().toISOString(),
  };

  return jsonRpcResult(rpcId, task);
}

// ── Agent dispatch ───────────────────────────────────────────────────────────

async function dispatchToAgent(
  cfg: ReturnType<typeof loadConfig>,
  agentId: string,
  inputText: string,
): Promise<string> {
  const sessionKey = `a2a:${agentId}:task:${randomUUID()}`;

  // Use the ingress command pipeline to dispatch a message to the agent
  // and collect the response text.
  const responseChunks: string[] = [];

  const collectPromise = new Promise<string>((resolve) => {
    let resolved = false;
    const unsub = onAgentEvent((event) => {
      if (resolved) {
        return;
      }
      const deltaText = resolveAssistantStreamDeltaText(event);
      if (deltaText) {
        responseChunks.push(deltaText);
      }
      // Check for run completion.
      if (
        event.type === "agent:run:complete" ||
        event.type === "agent:run:error"
      ) {
        resolved = true;
        unsub?.();
        resolve(responseChunks.join(""));
      }
    });

    // Safety timeout: resolve after 120s to avoid hanging.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsub?.();
        resolve(responseChunks.join("") || "Agent did not respond within the timeout.");
      }
    }, 120_000);
  });

  await agentCommandFromIngress({
    agentId,
    sessionKey,
    message: inputText,
    source: "a2a",
    // The ingress pipeline handles the rest (model resolution, tool execution, etc.)
  });

  return collectPromise;
}

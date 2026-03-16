import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendInvalidRequest, sendJson, setSseHeaders, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { resolveGatewayRequestContext } from "./http-utils.js";

const AGENT_CARD_PATH = "/.well-known/agent-card.json";
const MESSAGE_SEND_PATH = "/message/send";
const MESSAGE_STREAM_PATH = "/message/stream";
const TASKS_GET_PATH = "/tasks/get";
const TASKS_RESUBSCRIBE_PATH = "/tasks/resubscribe";
const DEFAULT_BODY_BYTES = 256 * 1024;
const PUBLIC_TASK_CACHE_MAX = 512;
const TASK_ID_NAMESPACE = "openclaw:m15:task:v1";
const CONTEXT_ID_NAMESPACE = "openclaw:m15:context:v1";

type PublicA2AEdgeHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type PublicA2AMessageBody = {
  message: string;
  model?: string;
  user?: string;
};

type PublicTaskStatus = "in_progress" | "completed" | "failed";

type PublicA2ATaskProjection = {
  kind: "public-a2a-task";
  schemaVersion: 1;
  taskId: string;
  contextId: string;
  status: PublicTaskStatus;
  output?: { text: string };
};

type PublicTaskCacheEntry = {
  task: PublicA2ATaskProjection;
  updatedAt: number;
};

const publicTaskCache = new Map<string, PublicTaskCacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

function parsePublicA2AMessageBody(body: unknown): PublicA2AMessageBody | null {
  if (!isRecord(body)) {
    return null;
  }
  const messageRaw = body.message;
  const message = typeof messageRaw === "string" ? messageRaw.trim() : "";
  if (!message) {
    return null;
  }
  const model = typeof body.model === "string" ? body.model : undefined;
  const user = typeof body.user === "string" ? body.user : undefined;
  return { message, model, user };
}

function shortDigest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 24);
}

export function derivePublicTaskId(runId: string): string {
  return `task_${shortDigest(`${TASK_ID_NAMESPACE}:${runId}`)}`;
}

export function derivePublicContextId(sessionKey: string): string {
  return `ctx_${shortDigest(`${CONTEXT_ID_NAMESPACE}:${sessionKey}`)}`;
}

export function projectPublicTask(params: {
  runId: string;
  sessionKey: string;
  status: PublicTaskStatus;
  outputText?: string;
}): PublicA2ATaskProjection {
  return {
    kind: "public-a2a-task",
    schemaVersion: 1,
    taskId: derivePublicTaskId(params.runId),
    contextId: derivePublicContextId(params.sessionKey),
    status: params.status,
    ...(typeof params.outputText === "string" && params.outputText.length > 0
      ? { output: { text: params.outputText } }
      : {}),
  };
}

function rememberProjectedTask(task: PublicA2ATaskProjection): PublicA2ATaskProjection {
  publicTaskCache.delete(task.taskId);
  publicTaskCache.set(task.taskId, {
    task,
    updatedAt: Date.now(),
  });
  while (publicTaskCache.size > PUBLIC_TASK_CACHE_MAX) {
    const oldestTaskId = publicTaskCache.keys().next().value;
    if (!oldestTaskId) {
      break;
    }
    publicTaskCache.delete(oldestTaskId);
  }
  return task;
}

function readProjectedTask(taskId: string): PublicA2ATaskProjection | undefined {
  const entry = publicTaskCache.get(taskId);
  if (!entry) {
    return undefined;
  }
  // Refresh recency for bounded in-memory cache behavior.
  publicTaskCache.delete(taskId);
  publicTaskCache.set(taskId, entry);
  return entry.task;
}

type PublicJsonRpcId = string | number | null;

type ParsedTasksGetRequest =
  | { ok: true; id: PublicJsonRpcId; taskId: string }
  | { ok: false; id: PublicJsonRpcId; message: string; code: number };

function parseJsonRpcId(value: unknown): PublicJsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }
  return null;
}

function parseTasksGetRequest(body: unknown): ParsedTasksGetRequest {
  if (!isRecord(body)) {
    return { ok: false, id: null, message: "invalid JSON-RPC request body", code: -32600 };
  }
  const id = parseJsonRpcId(body.id);
  if (body.jsonrpc !== "2.0") {
    return { ok: false, id, message: 'jsonrpc must be "2.0"', code: -32600 };
  }
  if (body.method !== "tasks/get") {
    return { ok: false, id, message: "method must be tasks/get", code: -32601 };
  }
  const params = isRecord(body.params) ? body.params : null;
  const taskIdRaw = typeof params?.taskId === "string" ? params.taskId.trim() : "";
  if (!taskIdRaw) {
    return { ok: false, id, message: "params.taskId is required", code: -32602 };
  }
  return {
    ok: true,
    id,
    taskId: taskIdRaw,
  };
}

type ParsedTasksResubscribeRequest =
  | { ok: true; id: PublicJsonRpcId; taskId: string }
  | { ok: false; id: PublicJsonRpcId; message: string; code: number };

function parseTasksResubscribeRequest(body: unknown): ParsedTasksResubscribeRequest {
  if (!isRecord(body)) {
    return { ok: false, id: null, message: "invalid JSON-RPC request body", code: -32600 };
  }
  const id = parseJsonRpcId(body.id);
  if (body.jsonrpc !== "2.0") {
    return { ok: false, id, message: 'jsonrpc must be "2.0"', code: -32600 };
  }
  if (body.method !== "tasks/resubscribe") {
    return { ok: false, id, message: "method must be tasks/resubscribe", code: -32601 };
  }
  const params = isRecord(body.params) ? body.params : null;
  const taskIdRaw = typeof params?.taskId === "string" ? params.taskId.trim() : "";
  if (!taskIdRaw) {
    return { ok: false, id, message: "params.taskId is required", code: -32602 };
  }
  return {
    ok: true,
    id,
    taskId: taskIdRaw,
  };
}

function sendJsonRpcResult(res: ServerResponse, id: PublicJsonRpcId, result: unknown): void {
  sendJson(res, 200, {
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendJsonRpcError(
  res: ServerResponse,
  params: { status: number; id: PublicJsonRpcId; code: number; message: string },
): void {
  sendJson(res, params.status, {
    jsonrpc: "2.0",
    id: params.id,
    error: {
      code: params.code,
      message: params.message,
    },
  });
}

type PublicAgentCard = {
  kind: "public-agent-card";
  schemaVersion: 1;
  name: string;
  description: string;
  supportedInterfaces: ["message/send", "message/stream", "tasks/get", "tasks/resubscribe"];
  endpoints: {
    agentCard: "/.well-known/agent-card.json";
    messageSend: "/message/send";
    messageStream: "/message/stream";
    tasksGet: "/tasks/get";
    tasksResubscribe: "/tasks/resubscribe";
  };
  securitySchemes: {
    agentCard: "none";
    messageSend: "bearer";
    messageStream: "bearer";
    tasksGet: "bearer";
    tasksResubscribe: "bearer";
  };
};

export function buildPublicAgentCard(): PublicAgentCard {
  return {
    kind: "public-agent-card",
    schemaVersion: 1,
    name: "OpenClaw Public A2A Edge",
    description: "Public discovery card for the OpenClaw A2A edge endpoints.",
    supportedInterfaces: ["message/send", "message/stream", "tasks/get", "tasks/resubscribe"],
    endpoints: {
      agentCard: AGENT_CARD_PATH,
      messageSend: MESSAGE_SEND_PATH,
      messageStream: MESSAGE_STREAM_PATH,
      tasksGet: TASKS_GET_PATH,
      tasksResubscribe: TASKS_RESUBSCRIBE_PATH,
    },
    securitySchemes: {
      agentCard: "none",
      messageSend: "bearer",
      messageStream: "bearer",
      tasksGet: "bearer",
      tasksResubscribe: "bearer",
    },
  };
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function handleAgentCardRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== AGENT_CARD_PATH) {
    return false;
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method Not Allowed");
    return true;
  }
  const card = buildPublicAgentCard();
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (method === "HEAD") {
    res.end();
    return true;
  }
  res.end(JSON.stringify(card));
  return true;
}

async function handleMessageSendRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PublicA2AEdgeHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: MESSAGE_SEND_PATH,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_BODY_BYTES,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const body = parsePublicA2AMessageBody(handled.body);
  if (!body) {
    sendInvalidRequest(res, "message is required");
    return true;
  }

  const { sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model: body.model,
    user: body.user,
    sessionPrefix: "a2a-public",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });
  const runId = `a2a_${randomUUID()}`;

  try {
    const result = await agentCommandFromIngress(
      {
        message: body.message,
        sessionKey,
        runId,
        deliver: false,
        messageChannel,
        bestEffortDeliver: false,
        senderIsOwner: true,
      },
      defaultRuntime,
      createDefaultDeps(),
    );
    const outputText = resolveAgentResponseText(result);
    const projectedTask = rememberProjectedTask(
      projectPublicTask({
        runId,
        sessionKey,
        status: "completed",
        outputText,
      }),
    );
    sendJson(res, 200, {
      task: projectedTask,
    });
  } catch (error) {
    logWarn(`public-a2a-edge: message/send failed: ${String(error)}`);
    const projectedTask = rememberProjectedTask(
      projectPublicTask({
        runId,
        sessionKey,
        status: "failed",
      }),
    );
    sendJson(res, 500, {
      task: projectedTask,
      error: { message: "internal error", type: "api_error" },
    });
  }
  return true;
}

async function handleMessageStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PublicA2AEdgeHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: MESSAGE_STREAM_PATH,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_BODY_BYTES,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const body = parsePublicA2AMessageBody(handled.body);
  if (!body) {
    sendInvalidRequest(res, "message is required");
    return true;
  }

  const { sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model: body.model,
    user: body.user,
    sessionPrefix: "a2a-public",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });
  const runId = `a2a_${randomUUID()}`;
  const taskId = derivePublicTaskId(runId);
  const contextId = derivePublicContextId(sessionKey);
  rememberProjectedTask(
    projectPublicTask({
      runId,
      sessionKey,
      status: "in_progress",
    }),
  );

  setSseHeaders(res);
  writeSseEvent(res, "task.started", {
    task: projectPublicTask({
      runId,
      sessionKey,
      status: "in_progress",
    }),
  });

  let closed = false;
  let accumulatedText = "";
  let sawAssistantDelta = false;

  const unsubscribe = onAgentEvent((event) => {
    if (event.runId !== runId || closed) {
      return;
    }
    if (event.stream !== "assistant") {
      return;
    }
    const delta = resolveAssistantStreamDeltaText(event);
    if (!delta) {
      return;
    }
    sawAssistantDelta = true;
    accumulatedText += delta;
    writeSseEvent(res, "message.delta", {
      taskId,
      contextId,
      delta,
    });
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommandFromIngress(
        {
          message: body.message,
          sessionKey,
          runId,
          deliver: false,
          messageChannel,
          bestEffortDeliver: false,
          senderIsOwner: true,
        },
        defaultRuntime,
        createDefaultDeps(),
      );
      if (closed) {
        return;
      }
      if (!sawAssistantDelta) {
        const fallback = resolveAgentResponseText(result);
        if (fallback) {
          accumulatedText = fallback;
          writeSseEvent(res, "message.delta", {
            taskId,
            contextId,
            delta: fallback,
          });
        }
      }
      const projectedTask = rememberProjectedTask(
        projectPublicTask({
          runId,
          sessionKey,
          status: "completed",
          outputText: accumulatedText || undefined,
        }),
      );
      writeSseEvent(res, "task.completed", {
        task: projectedTask,
      });
    } catch (error) {
      logWarn(`public-a2a-edge: message/stream failed: ${String(error)}`);
      if (!closed) {
        const projectedTask = rememberProjectedTask(
          projectPublicTask({
            runId,
            sessionKey,
            status: "failed",
          }),
        );
        writeSseEvent(res, "task.failed", {
          task: projectedTask,
        });
      }
    } finally {
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end" },
      });
      if (!closed) {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}

async function handleTasksGetRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PublicA2AEdgeHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: TASKS_GET_PATH,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_BODY_BYTES,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }
  const parsed = parseTasksGetRequest(handled.body);
  if (!parsed.ok) {
    sendJsonRpcError(res, {
      status: 400,
      id: parsed.id,
      code: parsed.code,
      message: parsed.message,
    });
    return true;
  }
  const task = readProjectedTask(parsed.taskId);
  if (!task) {
    sendJsonRpcError(res, {
      status: 404,
      id: parsed.id,
      code: -32004,
      message: "task not found",
    });
    return true;
  }
  sendJsonRpcResult(res, parsed.id, { task });
  return true;
}

async function handleTasksResubscribeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PublicA2AEdgeHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: TASKS_RESUBSCRIBE_PATH,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_BODY_BYTES,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }
  const parsed = parseTasksResubscribeRequest(handled.body);
  if (!parsed.ok) {
    sendJsonRpcError(res, {
      status: 400,
      id: parsed.id,
      code: parsed.code,
      message: parsed.message,
    });
    return true;
  }
  const task = readProjectedTask(parsed.taskId);
  if (!task) {
    sendJsonRpcError(res, {
      status: 404,
      id: parsed.id,
      code: -32004,
      message: "task not found",
    });
    return true;
  }

  setSseHeaders(res);
  if (task.status === "in_progress") {
    writeSseEvent(res, "task.started", { task });
  } else if (task.status === "failed") {
    writeSseEvent(res, "task.failed", { task });
  } else {
    const outputText = task.output?.text;
    if (typeof outputText === "string" && outputText.length > 0) {
      writeSseEvent(res, "message.delta", {
        taskId: task.taskId,
        contextId: task.contextId,
        delta: outputText,
      });
    }
    writeSseEvent(res, "task.completed", { task });
  }
  writeDone(res);
  res.end();
  return true;
}

export async function handlePublicA2AEdgeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PublicA2AEdgeHttpOptions,
): Promise<boolean> {
  if (handleAgentCardRequest(req, res)) {
    return true;
  }
  if (await handleMessageSendRequest(req, res, opts)) {
    return true;
  }
  if (await handleMessageStreamRequest(req, res, opts)) {
    return true;
  }
  if (await handleTasksGetRequest(req, res, opts)) {
    return true;
  }
  if (await handleTasksResubscribeRequest(req, res, opts)) {
    return true;
  }
  return false;
}

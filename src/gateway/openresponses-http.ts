/**
 * OpenResponses HTTP Handler
 *
 * Implements the OpenResponses `/v1/responses` endpoint for Clawdbot Gateway.
 *
 * @see https://www.open-responses.com/
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { buildHistoryContextFromEntries, type HistoryEntry } from "../auto-reply/reply/history.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { readJsonBody } from "./hooks.js";
import {
  CreateResponseBodySchema,
  type ContentPart,
  type CreateResponseBody,
  type ItemParam,
  type OutputItem,
  type ResponseResource,
  type StreamingEvent,
  type Usage,
} from "./open-responses.schema.js";
import type { ClientToolDefinition } from "../agents/pi-embedded-runner/run/params.js";
import type { ImageContent } from "../commands/agent/types.js";

type OpenResponsesHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = getHeader(req, "authorization")?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) return undefined;
  const token = raw.slice(7).trim();
  return token || undefined;
}

function writeSseEvent(res: ServerResponse, event: StreamingEvent) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeDone(res: ServerResponse) {
  res.write("data: [DONE]\n\n");
}

function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "input_text") return part.text;
      if (part.type === "output_text") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const PRIVATE_IP_PATTERNS = [
  /^127\./, // Loopback
  /^192\.168\./, // Private network
  /^10\./, // Private network
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private network
  /^::1$/, // IPv6 loopback
  /^fe80:/, // IPv6 link-local
  /^fec0:/, // IPv6 site-local
];

function isPrivateIp(hostname: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname));
}

// Fetch with SSRF protection, timeout, and size limits
async function fetchWithGuard(
  url: string,
  maxBytes: number,
  timeoutMs: number = 10000,
): Promise<{ data: string; mimeType: string }> {
  const parsedUrl = new URL(url);

  // Only allow HTTP/HTTPS
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`Invalid URL protocol: ${parsedUrl.protocol}. Only HTTP/HTTPS allowed.`);
  }

  // Block private IPs (SSRF protection)
  if (isPrivateIp(parsedUrl.hostname)) {
    throw new Error(`Private IP addresses are not allowed: ${parsedUrl.hostname}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Clawdbot-Gateway/1.0" },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (size > maxBytes) {
        throw new Error(`Content too large: ${size} bytes (limit: ${maxBytes} bytes)`);
      }
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Content too large: ${buffer.byteLength} bytes (limit: ${maxBytes} bytes)`);
    }

    const mimeType = response.headers.get("content-type") || "application/octet-stream";

    return {
      data: Buffer.from(buffer).toString("base64"),
      mimeType,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_FILE_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/pdf",
  "application/json",
]);

async function extractImageContent(part: ContentPart): Promise<ImageContent | null> {
  if (part.type !== "input_image") return null;

  const source = part.source as { type: string; url?: string; data?: string; media_type?: string };

  if (source.type === "base64") {
    if (!source.data) {
      throw new Error("input_image base64 source missing 'data' field");
    }
    const mimeType = source.media_type || "image/png";
    if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
      throw new Error(`Unsupported image MIME type: ${mimeType}`);
    }
    return { type: "image", data: source.data, mimeType };
  }

  if (source.type === "url" && source.url) {
    const result = await fetchWithGuard(source.url, MAX_IMAGE_BYTES);
    if (!ALLOWED_IMAGE_MIMES.has(result.mimeType)) {
      throw new Error(`Unsupported image MIME type from URL: ${result.mimeType}`);
    }
    return { type: "image", data: result.data, mimeType: result.mimeType };
  }

  throw new Error("input_image must have 'source.url' or 'source.data'");
}

async function extractFileContent(part: ContentPart): Promise<string | null> {
  if (part.type !== "input_file") return null;

  const source = part.source as {
    type: string;
    url?: string;
    data?: string;
    media_type?: string;
    filename?: string;
  };
  const filename = source.filename || "file";

  let content: string;

  if (source.type === "base64") {
    if (!source.data) {
      throw new Error("input_file base64 source missing 'data' field");
    }
    const buffer = Buffer.from(source.data, "base64");
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new Error(
        `File too large: ${buffer.byteLength} bytes (limit: ${MAX_FILE_BYTES} bytes)`,
      );
    }
    content = buffer.toString("utf-8");
  } else if (source.type === "url" && source.url) {
    const result = await fetchWithGuard(source.url, MAX_FILE_BYTES);
    if (!ALLOWED_FILE_MIMES.has(result.mimeType)) {
      throw new Error(`Unsupported file MIME type: ${result.mimeType}`);
    }
    content = Buffer.from(result.data, "base64").toString("utf-8");
  } else {
    throw new Error("input_file must have 'source.url' or 'source.data'");
  }

  return `<file name="${filename}">\n${content}\n</file>`;
}

function extractClientTools(body: CreateResponseBody): ClientToolDefinition[] {
  return (body.tools ?? []) as ClientToolDefinition[];
}

export function buildAgentPrompt(input: string | ItemParam[]): {
  message: string;
  extraSystemPrompt?: string;
} {
  if (typeof input === "string") {
    return { message: input };
  }

  const systemParts: string[] = [];
  const conversationEntries: Array<{ role: "user" | "assistant" | "tool"; entry: HistoryEntry }> =
    [];

  for (const item of input) {
    if (item.type === "message") {
      const content = extractTextContent(item.content).trim();
      if (!content) continue;

      if (item.role === "system" || item.role === "developer") {
        systemParts.push(content);
        continue;
      }

      const normalizedRole = item.role === "assistant" ? "assistant" : "user";
      const sender = normalizedRole === "assistant" ? "Assistant" : "User";

      conversationEntries.push({
        role: normalizedRole,
        entry: { sender, body: content },
      });
    } else if (item.type === "function_call_output") {
      conversationEntries.push({
        role: "tool",
        entry: { sender: `Tool:${item.call_id}`, body: item.output },
      });
    }
    // Skip reasoning and item_reference for prompt building (Phase 1)
  }

  let message = "";
  if (conversationEntries.length > 0) {
    // Find the last user or tool message as the current message
    let currentIndex = -1;
    for (let i = conversationEntries.length - 1; i >= 0; i -= 1) {
      const entryRole = conversationEntries[i]?.role;
      if (entryRole === "user" || entryRole === "tool") {
        currentIndex = i;
        break;
      }
    }
    if (currentIndex < 0) currentIndex = conversationEntries.length - 1;

    const currentEntry = conversationEntries[currentIndex]?.entry;
    if (currentEntry) {
      const historyEntries = conversationEntries.slice(0, currentIndex).map((entry) => entry.entry);
      if (historyEntries.length === 0) {
        message = currentEntry.body;
      } else {
        const formatEntry = (entry: HistoryEntry) => `${entry.sender}: ${entry.body}`;
        message = buildHistoryContextFromEntries({
          entries: [...historyEntries, currentEntry],
          currentMessage: formatEntry(currentEntry),
          formatEntry,
        });
      }
    }
  }

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined {
  const raw =
    getHeader(req, "x-clawdbot-agent-id")?.trim() ||
    getHeader(req, "x-clawdbot-agent")?.trim() ||
    "";
  if (!raw) return undefined;
  return normalizeAgentId(raw);
}

function resolveAgentIdFromModel(model: string | undefined): string | undefined {
  const raw = model?.trim();
  if (!raw) return undefined;

  const m =
    raw.match(/^clawdbot[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
    raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i);
  const agentId = m?.groups?.agentId;
  if (!agentId) return undefined;
  return normalizeAgentId(agentId);
}

function resolveAgentIdForRequest(params: {
  req: IncomingMessage;
  model: string | undefined;
}): string {
  const fromHeader = resolveAgentIdFromHeader(params.req);
  if (fromHeader) return fromHeader;

  const fromModel = resolveAgentIdFromModel(params.model);
  return fromModel ?? "main";
}

function resolveSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
}): string {
  const explicit = getHeader(params.req, "x-clawdbot-session-key")?.trim();
  if (explicit) return explicit;

  // Default: stateless per-request session key, but stable if OpenResponses "user" is provided.
  const user = params.user?.trim();
  const mainKey = user ? `openresponses-user:${user}` : `openresponses:${randomUUID()}`;
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}

function createEmptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function createResponseResource(params: {
  id: string;
  model: string;
  status: ResponseResource["status"];
  output: OutputItem[];
  usage?: Usage;
  error?: { code: string; message: string };
}): ResponseResource {
  return {
    id: params.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: params.status,
    model: params.model,
    output: params.output,
    usage: params.usage ?? createEmptyUsage(),
    error: params.error,
  };
}

function createAssistantOutputItem(params: {
  id: string;
  text: string;
  status?: "in_progress" | "completed";
}): OutputItem {
  return {
    type: "message",
    id: params.id,
    role: "assistant",
    content: [{ type: "output_text", text: params.text }],
    status: params.status,
  };
}

export async function handleOpenResponsesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenResponsesHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/v1/responses") return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
  });
  if (!authResult.ok) {
    sendJson(res, 401, {
      error: { message: "Unauthorized", type: "unauthorized" },
    });
    return true;
  }

  const body = await readJsonBody(req, opts.maxBodyBytes ?? 1024 * 1024);
  if (!body.ok) {
    sendJson(res, 400, {
      error: { message: body.error, type: "invalid_request_error" },
    });
    return true;
  }

  // Validate request body with Zod
  const parseResult = CreateResponseBodySchema.safeParse(body.value);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    const message = issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request body";
    sendJson(res, 400, {
      error: { message, type: "invalid_request_error" },
    });
    return true;
  }

  const payload: CreateResponseBody = parseResult.data;
  const stream = Boolean(payload.stream);
  const model = payload.model;
  const user = payload.user;

  // Extract images, files, and tools from input (Phase 2)
  let images: ImageContent[] = [];
  let fileContents: string[] = [];
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (item.type === "message" && typeof item.content !== "string") {
        for (const part of item.content) {
          const image = await extractImageContent(part);
          if (image) {
            images.push(image);
            continue;
          }
          const file = await extractFileContent(part);
          if (file) {
            fileContents.push(file);
          }
        }
      }
    }
  }

  const clientTools = extractClientTools(payload);
  const agentId = resolveAgentIdForRequest({ req, model });
  const sessionKey = resolveSessionKey({ req, agentId, user });

  // Build prompt from input
  const prompt = buildAgentPrompt(payload.input);

  // Append file contents to the message
  const fullMessage =
    fileContents.length > 0 ? `${prompt.message}\n\n${fileContents.join("\n\n")}` : prompt.message;

  // Handle instructions as extra system prompt
  const extraSystemPrompt = [payload.instructions, prompt.extraSystemPrompt]
    .filter(Boolean)
    .join("\n\n");

  if (!fullMessage) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `input`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const responseId = `resp_${randomUUID()}`;
  const outputItemId = `msg_${randomUUID()}`;
  const deps = createDefaultDeps();

  if (!stream) {
    try {
      const result = await agentCommand(
        {
          message: fullMessage,
          images: images.length > 0 ? images : undefined,
          clientTools: clientTools.length > 0 ? clientTools : undefined,
          extraSystemPrompt: extraSystemPrompt || undefined,
          sessionKey,
          runId: responseId,
          deliver: false,
          messageChannel: "webchat",
          bestEffortDeliver: false,
        },
        defaultRuntime,
        deps,
      );

      const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
      const meta = (result as { meta?: unknown } | null)?.meta;
      const stopReason =
        meta && typeof meta === "object" ? (meta as { stopReason?: string }).stopReason : undefined;
      const pendingToolCalls =
        meta && typeof meta === "object"
          ? (meta as { pendingToolCalls?: Array<{ id: string; name: string; arguments: string }> })
              .pendingToolCalls
          : undefined;

      // If agent called a client tool, return function_call instead of text
      if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
        const functionCall = pendingToolCalls[0];
        const response = createResponseResource({
          id: responseId,
          model,
          status: "incomplete",
          output: [
            {
              type: "function_call",
              id: functionCall.id,
              call_id: functionCall.id,
              name: functionCall.name,
              arguments: functionCall.arguments,
            },
          ],
        });
        sendJson(res, 200, response);
        return true;
      }

      const content =
        Array.isArray(payloads) && payloads.length > 0
          ? payloads
              .map((p) => (typeof p.text === "string" ? p.text : ""))
              .filter(Boolean)
              .join("\n\n")
          : "No response from Clawdbot.";

      const response = createResponseResource({
        id: responseId,
        model,
        status: "completed",
        output: [
          createAssistantOutputItem({ id: outputItemId, text: content, status: "completed" }),
        ],
      });

      sendJson(res, 200, response);
    } catch (err) {
      const response = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: String(err) },
      });
      sendJson(res, 500, response);
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming mode
  // ─────────────────────────────────────────────────────────────────────────

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let accumulatedText = "";
  let sawAssistantDelta = false;
  let closed = false;

  // Send initial events
  const initialResponse = createResponseResource({
    id: responseId,
    model,
    status: "in_progress",
    output: [],
  });

  writeSseEvent(res, { type: "response.created", response: initialResponse });

  // Add output item
  const outputItem = createAssistantOutputItem({
    id: outputItemId,
    text: "",
    status: "in_progress",
  });

  writeSseEvent(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: outputItem,
  });

  // Add content part
  writeSseEvent(res, {
    type: "response.content_part.added",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== responseId) return;
    if (closed) return;

    if (evt.stream === "assistant") {
      const delta = evt.data?.delta;
      const text = evt.data?.text;
      const content = typeof delta === "string" ? delta : typeof text === "string" ? text : "";
      if (!content) return;

      sawAssistantDelta = true;
      accumulatedText += content;

      writeSseEvent(res, {
        type: "response.output_text.delta",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: content,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        closed = true;
        unsubscribe();

        // Complete the stream with final events
        const finalText = accumulatedText || "No response from Clawdbot.";
        const finalStatus = phase === "error" ? "failed" : "completed";

        writeSseEvent(res, {
          type: "response.output_text.done",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          text: finalText,
        });

        writeSseEvent(res, {
          type: "response.content_part.done",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: finalText },
        });

        const completedItem = createAssistantOutputItem({
          id: outputItemId,
          text: finalText,
          status: "completed",
        });

        writeSseEvent(res, {
          type: "response.output_item.done",
          output_index: 0,
          item: completedItem,
        });

        const finalResponse = createResponseResource({
          id: responseId,
          model,
          status: finalStatus,
          output: [completedItem],
        });

        writeSseEvent(res, { type: "response.completed", response: finalResponse });
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
      const result = await agentCommand(
        {
          message: fullMessage,
          images: images.length > 0 ? images : undefined,
          clientTools: clientTools.length > 0 ? clientTools : undefined,
          extraSystemPrompt: extraSystemPrompt || undefined,
          sessionKey,
          runId: responseId,
          deliver: false,
          messageChannel: "webchat",
          bestEffortDeliver: false,
        },
        defaultRuntime,
        deps,
      );

      if (closed) return;

      // Fallback: if no streaming deltas were received, send the full response
      if (!sawAssistantDelta) {
        const resultAny = result as { payloads?: Array<{ text?: string }>; meta?: unknown };
        const payloads = resultAny.payloads;
        const meta = resultAny.meta;
        const stopReason =
          meta && typeof meta === "object"
            ? (meta as { stopReason?: string }).stopReason
            : undefined;
        const pendingToolCalls =
          meta && typeof meta === "object"
            ? (
                meta as {
                  pendingToolCalls?: Array<{ id: string; name: string; arguments: string }>;
                }
              ).pendingToolCalls
            : undefined;

        // If agent called a client tool, emit function_call instead of text
        if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
          const functionCall = pendingToolCalls[0];
          // Complete the text content part
          writeSseEvent(res, {
            type: "response.output_text.done",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            text: "",
          });
          writeSseEvent(res, {
            type: "response.content_part.done",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
          });

          // Complete the message item
          const completedItem = createAssistantOutputItem({
            id: outputItemId,
            text: "",
            status: "completed",
          });
          writeSseEvent(res, {
            type: "response.output_item.done",
            output_index: 0,
            item: completedItem,
          });

          // Send function_call item
          const functionCallItemId = `call_${randomUUID()}`;
          const functionCallItem = {
            type: "function_call" as const,
            id: functionCallItemId,
            call_id: functionCall.id,
            name: functionCall.name,
            arguments: functionCall.arguments,
          };
          writeSseEvent(res, {
            type: "response.output_item.added",
            output_index: 1,
            item: functionCallItem,
          });
          writeSseEvent(res, {
            type: "response.output_item.done",
            output_index: 1,
            item: { ...functionCallItem, status: "completed" as const },
          });
          writeSseEvent(res, {
            type: "response.output_item.done",
            output_index: 1,
            item: { ...functionCallItem, status: "completed" as const },
          });

          const incompleteResponse = createResponseResource({
            id: responseId,
            model,
            status: "incomplete",
            output: [completedItem, functionCallItem],
          });
          writeSseEvent(res, { type: "response.completed", response: incompleteResponse });
          writeDone(res);
          res.end();
          return;
        }

        const content =
          Array.isArray(payloads) && payloads.length > 0
            ? payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : "No response from Clawdbot.";

        accumulatedText = content;
        sawAssistantDelta = true;

        writeSseEvent(res, {
          type: "response.output_text.delta",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          delta: content,
        });
      }
    } catch (err) {
      if (closed) return;

      const errorResponse = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: String(err) },
      });

      writeSseEvent(res, { type: "response.failed", response: errorResponse });
      emitAgentEvent({
        runId: responseId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        // Emit lifecycle end to trigger completion
        emitAgentEvent({
          runId: responseId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
      }
    }
  })();

  return true;
}

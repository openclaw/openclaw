/**
 * Server-Sent Events endpoint for real-time agent observability.
 *
 * Exposes internal agent events (tool calls, lifecycle, errors) to external
 * clients for monitoring and debugging.
 *
 * Usage:
 *   GET /api/events/stream
 *   Accept: text/event-stream
 *
 * Events are JSON-encoded with the following structure:
 *   {
 *     "runId": "abc123",
 *     "stream": "tool" | "lifecycle" | "error" | "assistant",
 *     "sessionKey": "telegram:123",
 *     "ts": 1711054800000,
 *     "seq": 1,
 *     "data": { ... }
 *   }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { logInfo, logWarn } from "../logger.js";

/** Event streams to include in SSE output. Empty = all streams. */
const ALLOWED_STREAMS = new Set(["tool", "lifecycle", "error", "assistant"]);

/** Maximum events to buffer for new connections (recent history). */
const MAX_EVENT_BUFFER = 100;

/** Heartbeat interval to keep connection alive. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Event buffer for recent history (ring buffer). */
const eventBuffer: AgentEventPayload[] = [];

/** Connected SSE clients. */
const clients = new Set<ServerResponse>();

/** Whether the global event listener has been started. */
let listenerStarted = false;

/**
 * Start the global agent event listener.
 * This subscribes to onAgentEvent and broadcasts to all SSE clients.
 */
function ensureListenerStarted() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;

  onAgentEvent((event) => {
    // Filter to allowed streams
    if (ALLOWED_STREAMS.size > 0 && !ALLOWED_STREAMS.has(event.stream)) {
      return;
    }

    // Add to buffer (ring buffer behavior)
    eventBuffer.push(event);
    if (eventBuffer.length > MAX_EVENT_BUFFER) {
      eventBuffer.shift();
    }

    // Broadcast to all connected clients
    const data = JSON.stringify(event);
    for (const client of clients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
        // Client disconnected, will be cleaned up
      }
    }
  });

  logInfo("[agent-events-sse] Global event listener started");
}

/**
 * Format an event for SSE transmission.
 */
function formatSSEEvent(event: AgentEventPayload): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Send heartbeat to keep connection alive.
 */
function sendHeartbeat(res: ServerResponse) {
  try {
    res.write(`: heartbeat\n\n`);
  } catch {
    // Connection closed
  }
}

/**
 * Handle SSE connection request.
 */
export function handleAgentEventsSSE(req: IncomingMessage, res: ServerResponse) {
  // Ensure global listener is running
  ensureListenerStarted();

  // Parse query params for filtering
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const filterSessionKey = url.searchParams.get("sessionKey");
  const filterStream = url.searchParams.get("stream");
  const includeHistory = url.searchParams.get("history") !== "false";

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  });

  // Send initial connection event
  res.write(
    `data: ${JSON.stringify({
      type: "connected",
      ts: Date.now(),
      filters: {
        sessionKey: filterSessionKey,
        stream: filterStream,
      },
    })}\n\n`,
  );

  // Send buffered history
  if (includeHistory) {
    for (const event of eventBuffer) {
      // Apply filters
      if (filterSessionKey && event.sessionKey !== filterSessionKey) {
        continue;
      }
      if (filterStream && event.stream !== filterStream) {
        continue;
      }
      res.write(formatSSEEvent(event));
    }
  }

  // Add to client set
  clients.add(res);
  logInfo(`[agent-events-sse] Client connected (total: ${clients.size})`);

  // Set up heartbeat
  const heartbeatInterval = setInterval(() => {
    sendHeartbeat(res);
  }, HEARTBEAT_INTERVAL_MS);

  // Clean up on disconnect
  const cleanup = () => {
    clearInterval(heartbeatInterval);
    clients.delete(res);
    logInfo(`[agent-events-sse] Client disconnected (total: ${clients.size})`);
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("error", cleanup);
}

/**
 * Get current stats for monitoring.
 */
export function getAgentEventsSSEStats() {
  return {
    connectedClients: clients.size,
    bufferedEvents: eventBuffer.length,
    listenerActive: listenerStarted,
  };
}

/**
 * Check if request is for the SSE endpoint.
 */
export function isAgentEventsSSERequest(pathname: string): boolean {
  return pathname === "/api/events/stream" || pathname === "/events/stream";
}

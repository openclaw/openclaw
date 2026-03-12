/**
 * WebSocket transport — default AgentTransport implementation.
 *
 * Wraps the existing `callGateway()` RPC so all inter-agent
 * communication keeps flowing through the Gateway WebSocket
 * exactly as before.  No behavioural change.
 */

import crypto from "node:crypto";
import { callGateway } from "../gateway/call.js";
import type {
  AgentMessage,
  AgentReply,
  AgentTransport,
  MessageHandler,
  ResolveSessionParams,
  Unsubscribe,
} from "./transport.js";

// ── Helpers ────────────────────────────────────────────────────

function idempotencyKey(): string {
  return crypto.randomUUID();
}

function normalizeReply(raw: Record<string, unknown>): AgentReply {
  return {
    runId: typeof raw.runId === "string" ? raw.runId : "",
    status:
      raw.status === "ok" || raw.status === "timeout" || raw.status === "error"
        ? raw.status
        : "error",
    reply: typeof raw.reply === "string" ? raw.reply : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : undefined,
    endedAt: typeof raw.endedAt === "number" ? raw.endedAt : undefined,
  };
}

// ── Implementation ─────────────────────────────────────────────

export class WebSocketTransport implements AgentTransport {
  // ─── send (fire-and-forget) ────────────────────────────────

  async send(msg: AgentMessage): Promise<{ runId: string; status: "accepted" }> {
    const result = await callGateway<Record<string, unknown>>({
      method: "agent",
      params: {
        message: msg.message,
        sessionKey: msg.sessionKey,
        idempotencyKey: msg.runId || idempotencyKey(),
        deliver: false,
        ...(msg.metadata ?? {}),
      },
    });

    return {
      runId: typeof result?.runId === "string" ? result.runId : msg.runId,
      status: "accepted",
    };
  }

  // ─── sendAndWait ───────────────────────────────────────────

  async sendAndWait(msg: AgentMessage, timeoutMs: number): Promise<AgentReply> {
    const sendResult = await this.send(msg);
    return this.waitForRun(sendResult.runId, timeoutMs);
  }

  // ─── subscribe (no-op: WS events are server-side) ─────────

  subscribe(_sessionKey: string, _handler: MessageHandler): Unsubscribe {
    // In the WebSocket model the Gateway server pushes events
    // directly over the active WS connection.  There is nothing
    // to subscribe to on the client/tool side.
    return () => {};
  }

  // ─── broadcast (no-op: handled by the Gateway server) ─────

  broadcast(_event: string, _payload: unknown): void {
    // Broadcasting is an internal Gateway concern (server-chat.ts).
    // The transport layer does not need to replicate it when the
    // backend is WebSocket — the server already fans out events.
  }

  // ─── resolveSession ────────────────────────────────────────

  async resolveSession(params: ResolveSessionParams): Promise<{ key: string }> {
    const result = await callGateway<Record<string, unknown>>({
      method: "sessions.resolve",
      params: {
        ...(params.label ? { label: params.label } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      },
      timeoutMs: 10_000,
    });

    const key = typeof result?.key === "string" ? result.key.trim() : "";
    if (!key) {
      throw new Error("sessions.resolve returned an empty key");
    }
    return { key };
  }

  // ─── waitForRun ────────────────────────────────────────────

  async waitForRun(runId: string, timeoutMs: number): Promise<AgentReply> {
    const result = await callGateway<Record<string, unknown>>({
      method: "agent.wait",
      params: { runId, timeoutMs },
      timeoutMs: timeoutMs + 10_000, // transport-level margin
    });

    return normalizeReply({ runId, ...(result ?? {}) });
  }

  // ─── lifecycle (no-op: WS connections are per-call) ────────

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

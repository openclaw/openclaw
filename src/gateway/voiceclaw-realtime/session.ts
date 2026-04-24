import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import WebSocket, { type RawData } from "ws";
import { createDefaultDeps } from "../../cli/deps.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveAssistantStreamDeltaText } from "../agent-event-assistant-text.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
  type ResolvedGatewayAuth,
} from "../auth.js";
import { getPreauthHandshakeTimeoutMsFromEnv } from "../handshake-timeouts.js";
import { VoiceClawGeminiLiveAdapter } from "./gemini-live.js";
import { handleSynchronousToolCall, VOICECLAW_SERVER_SIDE_TOOLS } from "./tools.js";
import type {
  VoiceClawClientEvent,
  VoiceClawRealtimeAdapter,
  VoiceClawServerEvent,
  VoiceClawSessionConfigEvent,
  VoiceClawToolCallEvent,
} from "./types.js";

const log = createSubsystemLogger("gateway").child("voiceclaw-realtime");

type VoiceClawRealtimeSessionOptions = {
  ws: WebSocket;
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  releasePreauthBudget: () => void;
};

export class VoiceClawRealtimeSession {
  private readonly id = randomUUID();
  private readonly startedAt = Date.now();
  private readonly ws: WebSocket;
  private readonly req: IncomingMessage;
  private readonly auth: ResolvedGatewayAuth;
  private readonly trustedProxies: string[];
  private readonly allowRealIpFallback: boolean;
  private readonly rateLimiter: AuthRateLimiter | undefined;
  private readonly releasePreauthBudget: () => void;
  private readonly inFlightTools = new Map<string, AbortController>();
  private adapter: VoiceClawRealtimeAdapter | null = null;
  private config: VoiceClawSessionConfigEvent | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private configStarted = false;

  constructor(opts: VoiceClawRealtimeSessionOptions) {
    this.ws = opts.ws;
    this.req = opts.req;
    this.auth = opts.auth;
    this.trustedProxies = opts.trustedProxies;
    this.allowRealIpFallback = opts.allowRealIpFallback;
    this.rateLimiter = opts.rateLimiter;
    this.releasePreauthBudget = once(opts.releasePreauthBudget);
  }

  attach(): void {
    this.handshakeTimer = setTimeout(() => {
      if (!this.config && !this.closed) {
        log.warn(`session ${this.id} handshake timed out`);
        this.ws.close(1000, "handshake timeout");
      }
    }, getPreauthHandshakeTimeoutMsFromEnv());

    this.ws.on("message", (raw) => {
      void this.handleRawMessage(raw).catch((err) => {
        log.warn(`session ${this.id} message failed: ${String(err)}`);
        this.send({ type: "error", message: "internal error", code: 500 });
      });
    });
    this.ws.on("close", () => {
      void this.cleanup();
    });
    this.ws.on("error", (err) => {
      log.warn(`session ${this.id} websocket error: ${err.message}`);
    });
  }

  private async handleRawMessage(raw: RawData): Promise<void> {
    const event = parseClientEvent(raw);
    if (!event) {
      this.send({ type: "error", message: "invalid JSON event", code: 400 });
      return;
    }

    if (!this.config) {
      if (event.type !== "session.config") {
        this.send({ type: "error", message: "session.config required before media", code: 400 });
        return;
      }
      await this.startSession(event);
      return;
    }

    switch (event.type) {
      case "audio.append":
        this.adapter?.sendAudio(event.data);
        break;
      case "audio.commit":
        this.adapter?.commitAudio();
        break;
      case "frame.append":
        this.adapter?.sendFrame(event.data, event.mimeType);
        break;
      case "response.create":
        this.adapter?.createResponse();
        break;
      case "response.cancel":
        this.adapter?.cancelResponse();
        break;
      case "tool.result":
        this.adapter?.sendToolResult(event.callId, event.output);
        break;
      case "session.config":
        this.send({ type: "error", message: "session already configured", code: 400 });
        break;
    }
  }

  private async startSession(config: VoiceClawSessionConfigEvent): Promise<void> {
    if (this.configStarted) {
      return;
    }
    this.configStarted = true;
    this.clearHandshakeTimer();

    const authResult = await authorizeHttpGatewayConnect({
      auth: this.auth,
      connectAuth: config.apiKey ? { token: config.apiKey, password: config.apiKey } : null,
      req: this.req,
      trustedProxies: this.trustedProxies,
      allowRealIpFallback: this.allowRealIpFallback,
      rateLimiter: this.rateLimiter,
    });
    this.releasePreauthBudget();

    if (!authResult.ok) {
      this.send({ type: "error", message: "OpenClaw gateway authentication failed", code: 401 });
      this.ws.close(1008, "unauthorized");
      return;
    }
    if (
      config.brainAgent !== "none" &&
      this.auth.mode === "none" &&
      !isLocalDirectRequest(this.req, this.trustedProxies, this.allowRealIpFallback)
    ) {
      this.send({
        type: "error",
        message: "OpenClaw real-time brain requires gateway auth for non-local connections",
        code: 403,
      });
      this.ws.close(1008, "auth required");
      return;
    }

    this.config = {
      ...config,
      provider: "gemini",
      voice: config.voice || "Zephyr",
      brainAgent: config.brainAgent ?? "enabled",
    };
    this.adapter = new VoiceClawGeminiLiveAdapter();

    try {
      await this.adapter.connect(this.config, (event) => this.handleAdapterEvent(event));
      this.send({ type: "session.ready", sessionId: this.id });
    } catch (err) {
      this.send({
        type: "error",
        message:
          err instanceof Error
            ? sanitizeErrorMessage(err.message)
            : "failed to start real-time brain session",
        code: 500,
      });
      this.ws.close(1011, "setup failed");
    }
  }

  private handleAdapterEvent(event: VoiceClawServerEvent): void {
    if (event.type === "tool.call" && VOICECLAW_SERVER_SIDE_TOOLS.has(event.name)) {
      this.handleServerToolCall(event);
      return;
    }
    if (event.type === "tool.cancelled") {
      for (const callId of event.callIds) {
        this.inFlightTools.get(callId)?.abort();
        this.inFlightTools.delete(callId);
      }
    }
    this.send(event);
  }

  private handleServerToolCall(event: VoiceClawToolCallEvent): void {
    const syncResult = handleSynchronousToolCall(event.name, event.arguments);
    if (syncResult !== null) {
      this.adapter?.sendToolResult(event.callId, syncResult);
      return;
    }

    if (event.name === "ask_brain") {
      this.handleAskBrain(event.callId, event.arguments);
      return;
    }

    this.adapter?.sendToolResult(
      event.callId,
      JSON.stringify({ error: `unknown tool: ${event.name}` }),
    );
  }

  private handleAskBrain(callId: string, args: string): void {
    const query = parseAskBrainQuery(args);
    if (!query) {
      this.adapter?.sendToolResult(callId, JSON.stringify({ error: "missing query" }));
      return;
    }

    const controller = new AbortController();
    this.inFlightTools.set(callId, controller);
    this.adapter?.sendToolResult(
      callId,
      JSON.stringify({
        status: "searching",
        message: "Looking into it now. I'll share what I find in a moment.",
      }),
    );
    this.send({ type: "tool.progress", callId, summary: "Looking into it now..." });

    void this.runBrainAgent(callId, query, controller).finally(() => {
      this.inFlightTools.delete(callId);
    });
  }

  private async runBrainAgent(
    callId: string,
    query: string,
    controller: AbortController,
  ): Promise<void> {
    const runId = `voiceclaw_${randomUUID()}`;
    const sessionKey = this.resolveBrainSessionKey();
    const deps = createDefaultDeps();
    let assistantText = "";
    let closed = false;
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId !== runId || closed) {
        return;
      }
      if (event.stream !== "assistant") {
        return;
      }
      const delta = resolveAssistantStreamDeltaText(event) ?? "";
      if (!delta) {
        return;
      }
      assistantText += delta;
      this.send({ type: "tool.progress", callId, summary: assistantText });
    });

    try {
      const result = await agentCommandFromIngress(
        {
          message: query,
          sessionKey,
          runId,
          deliver: false,
          messageChannel: "voiceclaw",
          bestEffortDeliver: false,
          senderIsOwner: true,
          allowModelOverride: true,
          abortSignal: controller.signal,
        },
        defaultRuntime,
        deps,
      );

      if (controller.signal.aborted) {
        return;
      }

      const resultText = assistantText.trim() || resolveAgentResponseText(result);
      this.adapter?.injectContext(
        `[OpenClaw brain result for query: "${query}"]\n${resultText}\n\nPlease share this information with the user naturally.`,
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : "OpenClaw brain call failed";
        this.adapter?.injectContext(
          `[OpenClaw brain failed for query: "${query}": ${message}]\nLet the user know the search did not work and offer to try again.`,
        );
      }
    } finally {
      closed = true;
      unsubscribe();
    }
  }

  private resolveBrainSessionKey(): string {
    const configured = sanitizeSessionKey(this.config?.sessionKey);
    if (configured) {
      return `agent:main:voiceclaw:${configured}`;
    }
    return `agent:main:voiceclaw:${this.id}`;
  }

  private send(event: VoiceClawServerEvent): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(event));
  }

  private clearHandshakeTimer(): void {
    this.handshakeTimer = clearTimer(this.handshakeTimer);
  }

  private async cleanup(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.clearHandshakeTimer();
    this.releasePreauthBudget();
    for (const controller of this.inFlightTools.values()) {
      controller.abort();
    }
    this.inFlightTools.clear();
    const transcript = this.adapter?.getTranscript() ?? [];
    this.adapter?.disconnect();
    this.adapter = null;
    if (transcript.length > 0 && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        type: "session.ended",
        summary: "Real-time brain session ended.",
        durationSec: Math.round((Date.now() - this.startedAt) / 1000),
        turnCount: transcript.filter((entry) => entry.role === "user").length,
      });
    }
    this.closed = true;
  }
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) {
    clearTimeout(timer);
  }
  return null;
}

function parseClientEvent(raw: RawData): VoiceClawClientEvent | null {
  try {
    const parsed = JSON.parse(rawDataToString(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return null;
    }
    return parsed as VoiceClawClientEvent;
  } catch {
    return null;
  }
}

function parseAskBrainQuery(args: string): string | null {
  try {
    const parsed = JSON.parse(args) as { query?: unknown };
    return typeof parsed.query === "string" && parsed.query.trim() ? parsed.query.trim() : null;
  } catch {
    return null;
  }
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  return payloads
    .map((payload) => payload.text ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function sanitizeSessionKey(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 128);
  return sanitized || null;
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/([?&]key=)[^&\s]+/g, "$1***");
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) {
      return;
    }
    called = true;
    fn();
  };
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

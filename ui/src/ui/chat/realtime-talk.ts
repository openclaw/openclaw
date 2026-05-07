import { normalizeTalkTransport } from "../../../../src/talk/talk-session-controller.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import {
  BrowserFallbackRealtimeTalkTransport,
  shouldUseBrowserFallbackForRealtimeError,
} from "./realtime-talk-browser-fallback.ts";
import { GatewayRelayRealtimeTalkTransport } from "./realtime-talk-gateway-relay.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import {
  type RealtimeTalkCallbacks,
  type RealtimeTalkEvent,
  type RealtimeTalkGatewayRelaySessionResult,
  type RealtimeTalkJsonPcmWebSocketSessionResult,
  type RealtimeTalkSessionResult,
  type RealtimeTalkStatus,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
  type RealtimeTalkWebRtcSdpSessionResult,
} from "./realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

export type {
  RealtimeTalkCallbacks,
  RealtimeTalkEvent,
  RealtimeTalkSessionResult,
  RealtimeTalkStatus,
};

export type RealtimeTalkLaunchOptions = {
  provider?: string;
  model?: string;
  voice?: string;
  transport?: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
};

function createTransport(
  session: RealtimeTalkSessionResult,
  ctx: RealtimeTalkTransportContext,
): RealtimeTalkTransport {
  const transport = resolveTransport(session);
  if (transport === "webrtc") {
    return new WebRtcSdpRealtimeTalkTransport(session as RealtimeTalkWebRtcSdpSessionResult, ctx);
  }
  if (transport === "provider-websocket") {
    return new GoogleLiveRealtimeTalkTransport(
      session as RealtimeTalkJsonPcmWebSocketSessionResult,
      ctx,
    );
  }
  if (transport === "gateway-relay") {
    return new GatewayRelayRealtimeTalkTransport(
      session as RealtimeTalkGatewayRelaySessionResult,
      ctx,
    );
  }
  if (transport === "managed-room") {
    throw new Error("Managed-room realtime Talk sessions are not available in this UI yet");
  }
  const unknownTransport = (session as { transport?: string }).transport ?? "unknown";
  throw new Error(`Unsupported realtime Talk transport: ${unknownTransport}`);
}

function resolveTransport(session: RealtimeTalkSessionResult): string {
  return normalizeTalkTransport((session as { transport?: string }).transport) ?? "webrtc";
}

function compactLaunchParams(
  params: RealtimeTalkLaunchOptions & { sessionKey: string; mode?: string; brain?: string },
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

export class RealtimeTalkSession {
  private transport: RealtimeTalkTransport | null = null;
  private session: RealtimeTalkSessionResult | null = null;
  private closed = false;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks = {},
    private readonly options: RealtimeTalkLaunchOptions = {},
  ) {}

  async start(): Promise<void> {
    this.closed = false;
    this.callbacks.onStatus?.("connecting");
    try {
      const session = await this.createSession();
      if (this.closed) {
        return;
      }
      this.session = session;
      this.transport = createTransport(session, this.createTransportContext(session));
      await this.transport.start();
    } catch (error) {
      if (!shouldUseBrowserFallbackForRealtimeError(error)) {
        throw error;
      }
      if (this.closed) {
        return;
      }
      await this.startBrowserFallback(this.transport);
    }
  }

  private async createSession(): Promise<RealtimeTalkSessionResult> {
    try {
      return await this.client.request<RealtimeTalkSessionResult>(
        "talk.client.create",
        compactLaunchParams({
          sessionKey: this.sessionKey,
          ...this.options,
        }),
      );
    } catch (error) {
      if (this.options.transport && this.options.transport !== "gateway-relay") {
        throw error;
      }
      try {
        return await this.client.request<RealtimeTalkSessionResult>(
          "talk.session.create",
          compactLaunchParams({
            sessionKey: this.sessionKey,
            ...this.options,
            mode: "realtime",
            transport: this.options.transport ?? "gateway-relay",
            brain: "agent-consult",
          }),
        );
      } catch {
        throw error;
      }
    }
  }

  stop(): void {
    this.closed = true;
    this.callbacks.onStatus?.("idle");
    this.transport?.stop();
    this.transport = null;
    this.session = null;
  }

  private createTransportContext(session = this.session): RealtimeTalkTransportContext {
    return {
      client: this.client,
      sessionKey: this.sessionKey,
      callbacks: this.callbacks,
      consultThinkingLevel: session?.consultThinkingLevel,
      consultFastMode: session?.consultFastMode,
      onRecoverableError: (error, source) => this.requestBrowserFallback(error, source),
    };
  }

  private requestBrowserFallback(error: Error, source: RealtimeTalkTransport): boolean {
    if (!shouldUseBrowserFallbackForRealtimeError(error)) {
      return false;
    }
    if (this.closed || this.transport !== source) {
      return true;
    }
    void this.startBrowserFallback(source).catch((fallbackError) => {
      if (!this.closed) {
        this.callbacks.onStatus?.(
          "error",
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        );
      }
    });
    return true;
  }

  private async startBrowserFallback(source: RealtimeTalkTransport | null): Promise<void> {
    if (this.closed) {
      return;
    }
    if (source && this.transport !== source) {
      return;
    }
    source?.stop();
    const fallback = new BrowserFallbackRealtimeTalkTransport(this.createTransportContext());
    this.transport = fallback;
    await fallback.start();
  }
}

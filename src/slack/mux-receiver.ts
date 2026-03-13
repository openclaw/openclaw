import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { SlackMuxConfig } from "../config/types.slack.ts";
import type { RuntimeEnv } from "../runtime.ts";
import { audienceFromWsUrl, resolveGcpIdentityToken } from "../utils/gcp-metadata-token.ts";

type BoltApp = {
  processEvent(event: ReceiverEvent): Promise<void>;
  client: {
    apiCall(method: string, options?: Record<string, unknown>): Promise<unknown>;
  };
};

export type ReceiverEvent = {
  body: Record<string, unknown>;
  retryNum?: number;
  retryReason?: string;
  customProperties?: Record<string, unknown>;
  ack: (...args: unknown[]) => Promise<void>;
};

/** Inbound message from the mux: a forwarded Slack Events API envelope. */
type MuxSlackEvent = {
  type: "slack_event";
  /** Optional per-event ID used to route ack payloads back to the mux. */
  id?: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
};

type MuxApiResponse = {
  type: "slack_api_response";
  id: string;
  ok: boolean;
  response: Record<string, unknown>;
  error?: string;
};

type MuxPing = {
  type: "ping";
  ts?: number;
};

type MuxInbound = MuxSlackEvent | MuxApiResponse | MuxPing;

type PendingApiCall = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type MuxReceiverOptions = {
  mux: SlackMuxConfig;
  runtime?: RuntimeEnv;
};

const API_CALL_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
/** Client-side WebSocket ping interval to keep the connection alive through
 *  load balancers / proxies that drop idle connections (e.g. GKE Gateway
 *  default 30 s idle timeout). Must be well under the LB timeout. */
const CLIENT_PING_INTERVAL_MS = 15_000;

export class MuxReceiver {
  private app: BoltApp | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private pending = new Map<string, PendingApiCall>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private resolvedToken: string | null = null;
  /** Buffer events received before auth identity is initialized so that
   *  self-message and workspace/app mismatch guards are never bypassed. */
  private authReady = false;
  private pendingEvents: MuxSlackEvent[] = [];

  private readonly mux: SlackMuxConfig;
  private readonly runtime: RuntimeEnv | undefined;

  constructor(opts: MuxReceiverOptions) {
    this.mux = opts.mux;
    this.runtime = opts.runtime;
  }

  /** Called by Bolt's App constructor. */
  init(app: BoltApp): void {
    this.app = app;
  }

  /** Signal that auth identity is initialized. Flushes any buffered events
   *  that arrived during the startup window between WebSocket open and the
   *  completion of auth.test. */
  setAuthReady(): void {
    if (this.authReady) {
      return;
    }
    this.authReady = true;
    const buffered = this.pendingEvents.splice(0);
    for (const event of buffered) {
      this.handleSlackEvent(event);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refreshToken();
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopClientPing();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MuxReceiver stopped"));
      this.pending.delete(id);
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "shutdown");
      }
      this.ws = null;
    }
  }

  /**
   * Proxy a Slack Web API call through the mux WSS connection.
   * Returns the API response (or throws on timeout/error).
   */
  async apiCall(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("MuxReceiver: WebSocket not connected");
    }

    const id = randomUUID();
    const msg = JSON.stringify({ type: "slack_api", id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`MuxReceiver: API call ${method} timed out after ${API_CALL_TIMEOUT_MS}ms`),
        );
      }, API_CALL_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      ws.send(msg);
    });
  }

  // ── private ────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const url = this.mux.url;
    if (!url) {
      throw new Error("MuxReceiver: mux.url is required");
    }
    const headers: Record<string, string> = {};
    if (this.resolvedToken) {
      headers.authorization = `Bearer ${this.resolvedToken}`;
    }

    return new Promise<void>((resolve, reject) => {
      // Close any existing WebSocket before opening a new one to prevent
      // the mux from seeing two connections from the same entity (which
      // triggers a supersede → close → reconnect → supersede loop).
      if (this.ws) {
        const old = this.ws;
        this.ws = null;
        old.removeAllListeners();
        try {
          old.close(1000, "reconnecting");
        } catch {}
      }

      const ws = new WebSocket(url, { headers });
      this.ws = ws;
      let everOpened = false;

      ws.on("open", () => {
        everOpened = true;
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.startClientPing(ws);
        this.runtime?.log?.("slack mux connected");
        resolve();
      });

      ws.on("message", (data) => {
        this.handleMessage(data);
      });

      ws.on("close", (code, reason) => {
        const reasonStr = typeof reason === "string" ? reason : String(reason ?? "");
        this.runtime?.log?.(`slack mux disconnected: code=${code} reason=${reasonStr}`);
        this.stopClientPing();
        this.ws = null;
        // Fail any in-flight API calls immediately rather than letting them
        // hang for up to API_CALL_TIMEOUT_MS during a disconnect.
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("MuxReceiver: WebSocket disconnected"));
          this.pending.delete(id);
        }
        // Only reconnect after a successful open.  On the very first connection
        // attempt, error→close fires in sequence — the error handler already
        // rejected the connect() promise, so starting a background reconnect
        // loop would leave the receiver in an inconsistent state.
        if (everOpened) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        this.runtime?.error?.(`slack mux error: ${err.message}`);
        reject(err);
      });

      ws.on("ping", () => {
        ws.pong();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.runtime?.log?.(`slack mux reconnecting in ${delay}ms`);

    setTimeout(() => {
      if (this.stopped) {
        return;
      }
      this.refreshToken()
        .then(() => this.connect())
        .catch((err) => {
          this.runtime?.error?.(`slack mux reconnect failed: ${(err as Error).message}`);
          // The failed connect() won't schedule another reconnect because
          // everOpened is false for that attempt.  Keep retrying.
          this.scheduleReconnect();
        });
    }, delay);
  }

  /** Send periodic WebSocket pings to keep the connection alive through
   *  load balancers that drop idle connections. */
  private startClientPing(ws: WebSocket): void {
    this.stopClientPing();
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        // Send both protocol-level ping AND application-level ping.
        // GKE Cloud LB may not count WebSocket control frames (ping/pong)
        // as traffic for idle timeout — data frames are needed.
        ws.ping();
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }
    }, CLIENT_PING_INTERVAL_MS);
    if (this.pingTimer.unref) {
      this.pingTimer.unref();
    }
  }

  private stopClientPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleMessage(raw: unknown): void {
    let msg: MuxInbound;
    try {
      const text =
        typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
      msg = JSON.parse(text) as MuxInbound;
    } catch {
      this.runtime?.error?.("slack mux: failed to parse inbound message");
      return;
    }

    switch (msg.type) {
      case "slack_event":
        if (!this.authReady) {
          // Buffer events until auth identity is initialized to ensure
          // self-message and workspace/app filtering guards are populated.
          this.pendingEvents.push(msg);
        } else {
          this.handleSlackEvent(msg);
        }
        break;
      case "slack_api_response":
        this.handleApiResponse(msg);
        break;
      case "ping":
        this.ws?.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        break;
      default:
        break;
    }
  }

  private handleSlackEvent(msg: MuxSlackEvent): void {
    if (!this.app) {
      return;
    }

    // Forward Slack retry metadata so Bolt handlers can detect and deduplicate
    // retried event deliveries (x-slack-retry-num / x-slack-retry-reason).
    const retryNumRaw = msg.headers["x-slack-retry-num"];
    const retryReason = msg.headers["x-slack-retry-reason"];
    const eventId = msg.id;
    const event: ReceiverEvent = {
      body: msg.payload,
      // Propagate ack payload back through the mux so slash-command /
      // interactive-component handlers that call ack({ options: [...] }) or
      // ack(responsePayload) can return data to Slack via the mux server.
      // If no event id was provided (older mux versions), fall back to no-op.
      ack: async (...args: unknown[]) => {
        if (!eventId || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
          return;
        }
        const payload = args.length > 0 ? args[0] : undefined;
        this.ws.send(
          JSON.stringify({
            type: "slack_ack",
            id: eventId,
            ...(payload !== undefined ? { payload } : {}),
          }),
        );
      },
      ...(retryNumRaw !== undefined ? { retryNum: parseInt(retryNumRaw, 10) } : {}),
      ...(retryReason !== undefined ? { retryReason } : {}),
    };
    this.app.processEvent(event).catch((err) => {
      this.runtime?.error?.(`slack mux: processEvent error: ${err}`);
    });
  }

  private handleApiResponse(msg: MuxApiResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    if (msg.ok) {
      pending.resolve(msg.response);
    } else {
      pending.reject(new Error(msg.error ?? "Slack API error via mux"));
    }
  }

  // ── token resolution ───────────────────────────────────────────────

  /** Re-resolve the auth token.  Called on initial start and before each
   *  reconnect so that expired cached tokens are replaced. */
  private async refreshToken(): Promise<void> {
    this.resolvedToken = await this.resolveToken();
  }

  private async resolveToken(): Promise<string | null> {
    const configToken = this.mux.token?.trim();
    if (configToken) {
      return configToken;
    }

    const envToken = process.env.MUX_TOKEN?.trim();
    if (envToken) {
      return envToken;
    }

    // Try GCP identity token (ADC → metadata server fallback)
    const muxUrl = this.mux.url;
    if (muxUrl) {
      const gcpResult = await resolveGcpIdentityToken(audienceFromWsUrl(muxUrl));
      if (gcpResult) {
        this.runtime?.log?.(`slack mux: resolved GCP identity token from ${gcpResult.source}`);
        return gcpResult.token;
      }
    }

    try {
      return await this.resolveFromMcpRemoteCache();
    } catch {
      this.runtime?.log?.("slack mux: no cached mcp-remote token found");
      return null;
    }
  }

  private async resolveFromMcpRemoteCache(): Promise<string | null> {
    const mcpServerUrl = this.resolveMcpServerUrl();
    if (!mcpServerUrl) {
      return null;
    }

    const hash = createHash("md5").update(mcpServerUrl).digest("hex");
    const cacheBase = join(homedir(), ".mcp-auth");

    let dirs: string[];
    try {
      dirs = await readdir(cacheBase);
    } catch {
      return null;
    }

    const mcpRemoteDirs = dirs
      .filter((d) => d.startsWith("mcp-remote-"))
      .toSorted()
      .toReversed();

    for (const dir of mcpRemoteDirs) {
      const tokensPath = join(cacheBase, dir, `${hash}_tokens.json`);
      try {
        const raw = await readFile(tokensPath, "utf-8");
        const tokens = JSON.parse(raw) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
        };

        if (tokens.access_token && !this.isJwtExpired(tokens.access_token)) {
          return tokens.access_token;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private resolveMcpServerUrl(): string | null {
    if (this.mux.mcpServerUrl) {
      return this.mux.mcpServerUrl;
    }
    return process.env.MUX_MCP_SERVER_URL?.trim() || null;
  }

  private isJwtExpired(token: string): boolean {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return false;
      }
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as {
        exp?: number;
      };
      if (!payload.exp) {
        return false;
      }
      // Treat tokens as expired 60s *before* actual expiry to avoid using
      // nearly-expired tokens that may fail mid-request.
      return payload.exp < Date.now() / 1000 + 60;
    } catch {
      return false;
    }
  }

  // Token refresh (via OAuth refresh_token flow) is intentionally omitted to avoid raw
  // fetch() in channel runtime code. If the cached token is expired, the user should
  // re-authenticate via mcp-remote or set an explicit mux.token / MUX_TOKEN.
}

/**
 * Monkey-patch Bolt's `app.client` to route all Slack Web API calls through the mux.
 * Must be called after the Bolt App is created with a MuxReceiver.
 *
 * Bolt's `@slack/web-api` binds convenience methods (e.g. `chat.postMessage`) at
 * construction time via `self.apiCall.bind(self, method)`.  This captures the
 * *original* `apiCall` function reference — so simply replacing `app.client.apiCall`
 * after construction has no effect on convenience methods.
 *
 * To work around this, we:
 *  1. Replace the top-level `apiCall` (catches any direct callers).
 *  2. Recursively walk every method-group object on the client and replace each
 *     bound function with a new one that delegates to the proxy.
 */
export function installMuxApiProxy(
  app: {
    client: Record<string, unknown> & {
      apiCall: (method: string, options?: Record<string, unknown>) => Promise<unknown>;
    };
  },
  receiver: MuxReceiver,
): void {
  const proxyApiCall = async (
    method: string,
    options?: Record<string, unknown>,
  ): Promise<unknown> => {
    return receiver.apiCall(method, options ?? {});
  };

  // 1. Patch the top-level apiCall
  app.client.apiCall = proxyApiCall;

  // 2. Rebind all convenience methods that were captured via .bind() at construction.
  //    Method groups are plain objects hanging off app.client (e.g. client.chat,
  //    client.conversations, client.admin, ...).  Some are nested up to 4 levels
  //    deep (e.g. admin.apps.config.set).
  const skipKeys = new Set([
    // Internal / non-API properties that should not be walked
    "apiCall",
    "token",
    "slackApiUrl",
    "retryConfig",
    "requestQueue",
    "tlsConfig",
    "rejectRateLimitedCalls",
    "teamId",
    "logger",
    "axios",
    "middleware",
  ]);

  function rebindGroup(obj: Record<string, unknown>, prefix: string): void {
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (typeof value === "function") {
        const methodName = `${prefix}.${key}`;
        // Replace bound apiCall with proxy-routed version.
        // The original bound function had signature: (options?) => apiCall(method, options)
        // We replicate that, routing through the mux proxy instead.
        obj[key] = (options?: Record<string, unknown>): Promise<unknown> => {
          return proxyApiCall(methodName, options);
        };
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        // Recurse into nested groups (e.g. admin.apps.activities)
        rebindGroup(value as Record<string, unknown>, `${prefix}.${key}`);
      }
    }
  }

  for (const key of Object.keys(app.client)) {
    if (skipKeys.has(key)) {
      continue;
    }
    const value = app.client[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      rebindGroup(value as Record<string, unknown>, key);
    }
  }
}

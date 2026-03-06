import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { SlackMuxConfig } from "../config/types.slack.js";
import type { RuntimeEnv } from "../runtime.js";

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

export class MuxReceiver {
  private app: BoltApp | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private pending = new Map<string, PendingApiCall>();
  private resolvedToken: string | null = null;

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

  async start(): Promise<void> {
    this.stopped = false;
    this.resolvedToken = await this.resolveToken();
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
    const headers: Record<string, string> = {};
    if (this.resolvedToken) {
      headers.authorization = `Bearer ${this.resolvedToken}`;
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      this.ws = ws;

      ws.on("open", () => {
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.runtime?.log?.("slack mux connected");
        resolve();
      });

      ws.on("message", (data) => {
        this.handleMessage(data);
      });

      ws.on("close", (code, reason) => {
        const reasonStr = typeof reason === "string" ? reason : String(reason ?? "");
        this.runtime?.log?.(`slack mux disconnected: code=${code} reason=${reasonStr}`);
        this.ws = null;
        this.scheduleReconnect();
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
      this.connect().catch((err) => {
        this.runtime?.error?.(`slack mux reconnect failed: ${(err as Error).message}`);
      });
    }, delay);
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
        this.handleSlackEvent(msg);
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

    const event: ReceiverEvent = {
      body: msg.payload,
      ack: async () => {},
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

  private async resolveToken(): Promise<string | null> {
    const configToken = this.mux.token?.trim();
    if (configToken) {
      return configToken;
    }

    const envToken = process.env.MUX_TOKEN?.trim();
    if (envToken) {
      return envToken;
    }

    try {
      return await this.resolveFromMcpRemoteCache();
    } catch {
      this.runtime?.log?.("slack mux: no cached mcp-remote token found");
      return null;
    }
  }

  private async resolveFromMcpRemoteCache(): Promise<string | null> {
    const backstageMcpUrl = this.resolveBackstageMcpUrl();
    if (!backstageMcpUrl) {
      return null;
    }

    const hash = createHash("md5").update(backstageMcpUrl).digest("hex");
    const cacheBase = join(homedir(), ".mcp-auth");

    const { readdir } = await import("node:fs/promises");
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

  private resolveBackstageMcpUrl(): string | null {
    if (this.mux.backstageMcpUrl) {
      return this.mux.backstageMcpUrl;
    }
    if (this.mux.backstageUrl) {
      return `${this.mux.backstageUrl.replace(/\/+$/, "")}/api/mcp-actions/v1`;
    }
    return process.env.BACKSTAGE_MCP_URL?.trim() || null;
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
      return payload.exp < Date.now() / 1000 - 60;
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
 */
export function installMuxApiProxy(
  app: {
    client: Record<string, unknown> & {
      apiCall: (method: string, options?: Record<string, unknown>) => Promise<unknown>;
    };
  },
  receiver: MuxReceiver,
): void {
  app.client.apiCall = async (
    method: string,
    options?: Record<string, unknown>,
  ): Promise<unknown> => {
    return receiver.apiCall(method, options);
  };
}

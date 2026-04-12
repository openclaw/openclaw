import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { A2UI_ACTIVITY_WS_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostActivityConfig } from "../config/types.gateway.js";

type WebSocketModule = typeof import("ws");

export type A2uiActivityHub = {
  enabled: boolean;
  token?: string;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<boolean>;
  broadcastPush: (jsonl: string) => void;
  broadcastReset: () => void;
  close: () => Promise<void>;
};

type A2uiActivityPayload =
  | { type: "a2ui.state"; jsonl: string; updatedAt: number }
  | { type: "a2ui.push"; jsonl: string; updatedAt: number }
  | { type: "a2ui.reset"; updatedAt: number };

const ACTIVITY_TOKEN_QUERY_KEYS = ["activityToken", "a2uiToken"] as const;
const ACTIVITY_TOKEN_COOKIE_KEYS = new Set(["activityToken", "a2uiToken", "openclawActivityToken"]);
const DISCORD_ACTIVITY_LAUNCH_QUERY_KEYS = ["instance_id", "frame_id", "platform"] as const;
export const DISCORD_ACTIVITY_CONTEXT_COOKIE_KEY = "openclawDiscordActivity";

function resolveActivityTokenFromUrl(url: URL): string | undefined {
  for (const key of ACTIVITY_TOKEN_QUERY_KEYS) {
    const raw = url.searchParams.get(key);
    const trimmed = raw?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function hasDiscordActivityLaunchQuery(url: URL): boolean {
  return DISCORD_ACTIVITY_LAUNCH_QUERY_KEYS.some((key) => {
    const raw = url.searchParams.get(key);
    return typeof raw === "string" && raw.trim().length > 0;
  });
}

function tryDecodeTokenValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveActivityTokenFromCookieHeader(cookieHeader: string): string | undefined {
  for (const pair of cookieHeader.split(";")) {
    const [rawName, ...valueParts] = pair.split("=");
    const name = rawName?.trim();
    if (!name || !ACTIVITY_TOKEN_COOKIE_KEYS.has(name)) {
      continue;
    }
    const value = tryDecodeTokenValue(valueParts.join("=")).trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function hasDiscordActivityContextCookie(cookieHeader: string): boolean {
  for (const pair of cookieHeader.split(";")) {
    const [rawName, ...valueParts] = pair.split("=");
    const name = rawName?.trim();
    if (name !== DISCORD_ACTIVITY_CONTEXT_COOKIE_KEY) {
      continue;
    }
    const value = tryDecodeTokenValue(valueParts.join("=")).trim().toLowerCase();
    if (value === "1" || value === "true" || value === "yes") {
      return true;
    }
  }
  return false;
}

function resolveActivityToken(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const fromRequestUrl = resolveActivityTokenFromUrl(url);
  if (fromRequestUrl) {
    return fromRequestUrl;
  }

  const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : undefined;
  if (cookieHeader) {
    const fromCookie = resolveActivityTokenFromCookieHeader(cookieHeader);
    if (fromCookie) {
      return fromCookie;
    }
  }

  const refererHeader = typeof req.headers.referer === "string" ? req.headers.referer : undefined;
  if (refererHeader) {
    try {
      const refererUrl = new URL(refererHeader);
      const fromReferer = resolveActivityTokenFromUrl(refererUrl);
      if (fromReferer) {
        return fromReferer;
      }
    } catch {
      // ignore malformed referer
    }
  }

  return undefined;
}

export function hasDiscordActivityLaunchContext(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (hasDiscordActivityLaunchQuery(url)) {
    return true;
  }

  const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : undefined;
  if (cookieHeader && hasDiscordActivityContextCookie(cookieHeader)) {
    return true;
  }

  const refererHeader = typeof req.headers.referer === "string" ? req.headers.referer : undefined;
  if (refererHeader) {
    try {
      const refererUrl = new URL(refererHeader);
      if (hasDiscordActivityLaunchQuery(refererUrl)) {
        return true;
      }
    } catch {
      // ignore malformed referer
    }
  }

  return false;
}

export function isCanvasActivityAccessAllowed(
  activity: CanvasHostActivityConfig | undefined,
  req: IncomingMessage,
): boolean {
  if (!activity?.enabled) {
    return false;
  }
  if (activity.requireLaunchContext !== false && !hasDiscordActivityLaunchContext(req)) {
    return false;
  }
  const configuredToken = activity.token?.trim();
  if (!configuredToken) {
    return true;
  }
  return resolveActivityToken(req) === configuredToken;
}

async function loadWebSocketModule(): Promise<WebSocketModule> {
  return await import("ws");
}

function sendPayload(ws: import("ws").WebSocket, payload: A2uiActivityPayload) {
  if (ws.readyState !== ws.OPEN) {
    return;
  }
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore send errors
  }
}

export function createA2uiActivityHub(params: {
  activity?: CanvasHostActivityConfig;
}): A2uiActivityHub {
  const enabled = params.activity?.enabled === true;
  const token = params.activity?.token?.trim() || undefined;
  if (!enabled) {
    return {
      enabled: false,
      token,
      handleUpgrade: async () => false,
      broadcastPush: () => {},
      broadcastReset: () => {},
      close: async () => {},
    };
  }

  const clients = new Set<import("ws").WebSocket>();
  let wss: import("ws").WebSocketServer | null = null;
  let wssInitPromise: Promise<import("ws").WebSocketServer> | undefined;
  let lastJsonl: string | null = null;
  let lastUpdatedAt = 0;

  const ensureWss = async () => {
    if (wss) {
      return wss;
    }
    if (!wssInitPromise) {
      wssInitPromise = (async () => {
        const { WebSocketServer } = await loadWebSocketModule();
        const created = new WebSocketServer({ noServer: true });
        created.on("connection", (ws) => {
          clients.add(ws);
          if (lastJsonl) {
            sendPayload(ws, { type: "a2ui.state", jsonl: lastJsonl, updatedAt: lastUpdatedAt });
          } else if (lastUpdatedAt > 0) {
            sendPayload(ws, { type: "a2ui.reset", updatedAt: lastUpdatedAt });
          }
          ws.on("close", () => {
            clients.delete(ws);
          });
        });
        wss = created;
        return created;
      })();
    }
    return await wssInitPromise;
  };

  const broadcast = (payload: A2uiActivityPayload) => {
    for (const ws of clients) {
      sendPayload(ws, payload);
    }
  };

  return {
    enabled,
    token,
    handleUpgrade: async (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== A2UI_ACTIVITY_WS_PATH) {
        return false;
      }
      const activeWss = await ensureWss();
      activeWss.handleUpgrade(req, socket as import("node:net").Socket, head, (ws) => {
        activeWss.emit("connection", ws, req);
      });
      return true;
    },
    broadcastPush: (jsonl: string) => {
      lastJsonl = jsonl;
      lastUpdatedAt = Date.now();
      broadcast({ type: "a2ui.push", jsonl, updatedAt: lastUpdatedAt });
    },
    broadcastReset: () => {
      lastJsonl = null;
      lastUpdatedAt = Date.now();
      broadcast({ type: "a2ui.reset", updatedAt: lastUpdatedAt });
    },
    close: async () => {
      const activeWss = wss;
      if (!activeWss) {
        return;
      }
      for (const ws of clients) {
        try {
          ws.terminate();
        } catch {
          // ignore terminate errors
        }
      }
      await new Promise<void>((resolve) => activeWss.close(() => resolve()));
      clients.clear();
      wss = null;
      wssInitPromise = undefined;
    },
  };
}

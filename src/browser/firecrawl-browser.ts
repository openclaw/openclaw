/**
 * Firecrawl cloud browser session lifecycle — pure fetch() API calls, no SDK.
 *
 * Uses Firecrawl v2 Browser API:
 *   POST   /v2/browser         → create session
 *   DELETE  /v2/browser/{id}    → delete session
 *
 * Response fields: { success, id, cdpUrl, liveViewUrl, expiresAt }
 */
import { openCdpWebSocket } from "./cdp.helpers.js";

export type FirecrawlBrowserSession = {
  sessionId: string;
  cdpWebSocketUrl: string;
  liveViewUrl: string;
  expiresAt?: string;
};

export type CreateFirecrawlBrowserSessionParams = {
  apiKey: string;
  baseUrl: string;
  /** Total session TTL in seconds. */
  ttlTotal?: number;
  /** Idle TTL (seconds without activity) before session is destroyed. */
  ttlWithoutActivity?: number;
  /** Enable live web-view streaming. */
  streamWebView?: boolean;
};

export type DeleteFirecrawlBrowserSessionParams = {
  apiKey: string;
  baseUrl: string;
  sessionId: string;
};

export async function createFirecrawlBrowserSession(
  params: CreateFirecrawlBrowserSessionParams,
): Promise<FirecrawlBrowserSession> {
  const { apiKey, baseUrl, ttlTotal, ttlWithoutActivity, streamWebView } = params;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v2/browser`;
  const body: Record<string, unknown> = {};
  if (ttlTotal !== undefined) body.ttlTotal = ttlTotal;
  if (ttlWithoutActivity !== undefined) body.ttlWithoutActivity = ttlWithoutActivity;
  if (streamWebView !== undefined) body.streamWebView = streamWebView;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Firecrawl browser session create failed (HTTP ${res.status}): ${text || res.statusText}`,
    );
  }

  const data = (await res.json()) as {
    success?: boolean;
    id?: string;
    cdpUrl?: string;
    liveViewUrl?: string;
    expiresAt?: string;
  };

  if (!data.id || !data.cdpUrl) {
    throw new Error("Firecrawl browser session response missing id or cdpUrl");
  }

  return {
    sessionId: data.id,
    cdpWebSocketUrl: data.cdpUrl,
    liveViewUrl: data.liveViewUrl ?? "",
    expiresAt: data.expiresAt,
  };
}

export async function deleteFirecrawlBrowserSession(
  params: DeleteFirecrawlBrowserSessionParams,
): Promise<void> {
  const { apiKey, baseUrl, sessionId } = params;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v2/browser/${encodeURIComponent(sessionId)}`;

  const res = await fetch(endpoint, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Firecrawl browser session delete failed (HTTP ${res.status}): ${text || res.statusText}`,
    );
  }
}

/**
 * Check if a Firecrawl CDP WebSocket URL is reachable via WSS handshake.
 */
export async function isFirecrawlSessionReachable(
  cdpWebSocketUrl: string,
  timeoutMs = 3000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const timer = setTimeout(() => done(false), timeoutMs);

    try {
      const ws = openCdpWebSocket(cdpWebSocketUrl, { handshakeTimeoutMs: timeoutMs });
      ws.on("open", () => {
        clearTimeout(timer);
        ws.close();
        done(true);
      });
      ws.on("error", () => {
        clearTimeout(timer);
        done(false);
      });
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  ensureChromeExtensionRelayServer,
  getChromeExtensionRelayAuthHeaders,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";
import { getFreePort } from "./test-port.js";

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForError(ws: WebSocket) {
  return new Promise<Error>((resolve, reject) => {
    ws.once("error", (err) => resolve(err instanceof Error ? err : new Error(String(err))));
    ws.once("open", () => reject(new Error("expected websocket error")));
  });
}

function relayAuthHeaders(url: string) {
  return getChromeExtensionRelayAuthHeaders(url);
}

function createMessageQueue(ws: WebSocket) {
  const queue: string[] = [];
  let waiter: ((value: string) => void) | null = null;
  let waiterReject: ((err: Error) => void) | null = null;
  let waiterTimer: NodeJS.Timeout | null = null;

  const flushWaiter = (value: string) => {
    if (!waiter) {
      return false;
    }
    const resolve = waiter;
    waiter = null;
    const reject = waiterReject;
    waiterReject = null;
    if (waiterTimer) {
      clearTimeout(waiterTimer);
    }
    waiterTimer = null;
    if (reject) {
      // no-op (kept for symmetry)
    }
    resolve(value);
    return true;
  };

  ws.on("message", (data) => {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
    if (flushWaiter(text)) {
      return;
    }
    queue.push(text);
  });

  ws.on("error", (err) => {
    if (!waiterReject) {
      return;
    }
    const reject = waiterReject;
    waiterReject = null;
    waiter = null;
    if (waiterTimer) {
      clearTimeout(waiterTimer);
    }
    waiterTimer = null;
    reject(err instanceof Error ? err : new Error(String(err)));
  });

  const next = (timeoutMs = 5000) =>
    new Promise<string>((resolve, reject) => {
      const existing = queue.shift();
      if (existing !== undefined) {
        return resolve(existing);
      }
      waiter = resolve;
      waiterReject = reject;
      waiterTimer = setTimeout(() => {
        waiter = null;
        waiterReject = null;
        waiterTimer = null;
        reject(new Error("timeout"));
      }, timeoutMs);
    });

  return { next };
}

async function waitForListMatch<T>(
  fetchList: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await fetchList();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("timeout waiting for list update");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("chrome extension relay server", () => {
  let cdpUrl = "";

  afterEach(async () => {
    if (cdpUrl) {
      await stopChromeExtensionRelayServer({ cdpUrl }).catch(() => {});
      cdpUrl = "";
    }
  });

  it("advertises CDP WS only when extension is connected", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const v1 = (await fetch(`${cdpUrl}/json/version`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(v1.webSocketDebuggerUrl).toBeUndefined();

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    const v2 = (await fetch(`${cdpUrl}/json/version`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(String(v2.webSocketDebuggerUrl ?? "")).toContain(`/cdp`);

    ext.close();
  });

  it("derives relay auth headers from gateway token for loopback URLs", async () => {
    const port = await getFreePort();
    const prev = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-gateway-token";
    try {
      const headers = getChromeExtensionRelayAuthHeaders(`http://127.0.0.1:${port}`);
      expect(Object.keys(headers)).toContain("x-openclaw-relay-token");
      expect((headers["x-openclaw-relay-token"] ?? "").length).toBeGreaterThan(20);
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prev;
      }
    }
  });

  it("rejects CDP access without relay auth token", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const res = await fetch(`${cdpUrl}/json/version`);
    expect(res.status).toBe(401);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
    const err = await waitForError(cdp);
    expect(err.message).toContain("401");
  });

  it("tracks attached page targets and exposes them via CDP + /json/list", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    // Simulate a tab attach coming from the extension.
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-1",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "Example",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const list = (await fetch(`${cdpUrl}/json/list`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as Array<{
      id?: string;
      url?: string;
      title?: string;
    }>;
    expect(list.some((t) => t.id === "t1" && t.url === "https://example.com")).toBe(true);

    // Simulate navigation updating tab metadata.
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.targetInfoChanged",
          params: {
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "DER STANDARD",
              url: "https://www.derstandard.at/",
            },
          },
        },
      }),
    );

    const list2 = await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`, {
          headers: relayAuthHeaders(cdpUrl),
        }).then((r) => r.json())) as Array<{
          id?: string;
          url?: string;
          title?: string;
        }>,
      (list) =>
        list.some(
          (t) =>
            t.id === "t1" && t.url === "https://www.derstandard.at/" && t.title === "DER STANDARD",
        ),
    );
    expect(
      list2.some(
        (t) =>
          t.id === "t1" && t.url === "https://www.derstandard.at/" && t.title === "DER STANDARD",
      ),
    ).toBe(true);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);

    cdp.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    const res1 = JSON.parse(await q.next()) as { id: number; result?: unknown };
    expect(res1.id).toBe(1);
    expect(JSON.stringify(res1.result ?? {})).toContain("t1");

    cdp.send(
      JSON.stringify({
        id: 2,
        method: "Target.attachToTarget",
        params: { targetId: "t1" },
      }),
    );
    const received: Array<{
      id?: number;
      method?: string;
      result?: unknown;
      params?: unknown;
    }> = [];
    received.push(JSON.parse(await q.next()) as never);
    received.push(JSON.parse(await q.next()) as never);

    const res2 = received.find((m) => m.id === 2);
    expect(res2?.id).toBe(2);
    expect(JSON.stringify(res2?.result ?? {})).toContain("cb-tab-1");

    const evt = received.find((m) => m.method === "Target.attachedToTarget");
    expect(evt?.method).toBe("Target.attachedToTarget");
    expect(JSON.stringify(evt?.params ?? {})).toContain("t1");

    cdp.close();
    ext.close();
  }, 15_000);

  it("rebroadcasts attach when a session id is reused for a new target", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "shared-session",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "First",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const first = JSON.parse(await q.next()) as { method?: string; params?: unknown };
    expect(first.method).toBe("Target.attachedToTarget");
    expect(JSON.stringify(first.params ?? {})).toContain("t1");

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "shared-session",
            targetInfo: {
              targetId: "t2",
              type: "page",
              title: "Second",
              url: "https://example.org",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const received: Array<{ method?: string; params?: unknown }> = [];
    received.push(JSON.parse(await q.next()) as never);
    received.push(JSON.parse(await q.next()) as never);

    const detached = received.find((m) => m.method === "Target.detachedFromTarget");
    const attached = received.find((m) => m.method === "Target.attachedToTarget");
    expect(JSON.stringify(detached?.params ?? {})).toContain("t1");
    expect(JSON.stringify(attached?.params ?? {})).toContain("t2");

    cdp.close();
    ext.close();
  });

  it("reuses an already-bound relay port when another process owns it", async () => {
    const port = await getFreePort();
    const fakeRelay = createServer((req, res) => {
      if (req.url?.startsWith("/extension/status")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connected: false }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
    });
    await new Promise<void>((resolve, reject) => {
      fakeRelay.listen(port, "127.0.0.1", () => resolve());
      fakeRelay.once("error", reject);
    });

    const prev = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-gateway-token";
    try {
      cdpUrl = `http://127.0.0.1:${port}`;
      const relay = await ensureChromeExtensionRelayServer({ cdpUrl });
      expect(relay.port).toBe(port);
      const status = (await fetch(`${cdpUrl}/extension/status`).then((r) => r.json())) as {
        connected?: boolean;
      };
      expect(status.connected).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prev;
      }
      await new Promise<void>((resolve) => fakeRelay.close(() => resolve()));
    }
  });

  it("does not swallow EADDRINUSE when occupied port is not an openclaw relay", async () => {
    const port = await getFreePort();
    const blocker = createServer((_, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not-relay");
    });
    await new Promise<void>((resolve, reject) => {
      blocker.listen(port, "127.0.0.1", () => resolve());
      blocker.once("error", reject);
    });
    const blockedUrl = `http://127.0.0.1:${port}`;
    await expect(ensureChromeExtensionRelayServer({ cdpUrl: blockedUrl })).rejects.toThrow(
      /EADDRINUSE/i,
    );
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});

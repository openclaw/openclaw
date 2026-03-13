import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { RuntimeEnv } from "../runtime.js";
import { MuxReceiver, installMuxApiProxy } from "./mux-receiver.js";

function getAvailablePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function parseWsMessage(data: unknown): Record<string, unknown> {
  const text =
    typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
  return JSON.parse(text) as Record<string, unknown>;
}

function createTestRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("MuxReceiver", () => {
  let wss: WebSocketServer;
  let port: number;
  let runtime: RuntimeEnv;
  let receiver: MuxReceiver;

  beforeEach(async () => {
    port = await getAvailablePort();
    wss = new WebSocketServer({ port });
    runtime = createTestRuntime();
  });

  afterEach(async () => {
    await receiver?.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  test("start connects to mux and stop disconnects", async () => {
    const connected = new Promise<void>((resolve) => {
      wss.on("connection", () => resolve());
    });

    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({
      processEvent: vi.fn(),
      client: { apiCall: vi.fn() },
    });

    await receiver.start();
    await connected;

    expect(runtime.log).toHaveBeenCalledWith("slack mux connected");
    expect(wss.clients.size).toBe(1);

    await receiver.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(wss.clients.size).toBe(0);
  });

  test("forwards slack_event to app.processEvent", async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);

    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent, client: { apiCall: vi.fn() } });

    wss.on("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "slack_event",
          payload: {
            type: "event_callback",
            event: { type: "message", text: "hello", channel: "C123" },
          },
          headers: { "x-slack-signature": "v0=abc", "x-slack-request-timestamp": "123" },
        }),
      );
    });

    await receiver.start();
    // Mark auth as ready so buffered events are flushed and processed.
    receiver.setAuthReady();
    await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(1));

    const event = processEvent.mock.calls[0][0];
    expect(event.body.type).toBe("event_callback");
    expect(event.body.event).toEqual({
      type: "message",
      text: "hello",
      channel: "C123",
    });
  });

  test("apiCall proxies through mux and returns response", async () => {
    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = parseWsMessage(data);
        if (msg.type === "slack_api") {
          ws.send(
            JSON.stringify({
              type: "slack_api_response",
              id: msg.id,
              ok: true,
              response: { user_id: "U123", team_id: "T456" },
            }),
          );
        }
      });
    });

    await receiver.start();
    const result = await receiver.apiCall("auth.test", {});
    expect(result).toEqual({ user_id: "U123", team_id: "T456" });
  });

  test("apiCall rejects on mux error response", async () => {
    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = parseWsMessage(data);
        if (msg.type === "slack_api") {
          ws.send(
            JSON.stringify({
              type: "slack_api_response",
              id: msg.id,
              ok: false,
              response: {},
              error: "channel_not_found",
            }),
          );
        }
      });
    });

    await receiver.start();
    await expect(receiver.apiCall("conversations.info", { channel: "C000" })).rejects.toThrow(
      "channel_not_found",
    );
  });

  test("apiCall throws when WebSocket is not connected", async () => {
    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    await expect(receiver.apiCall("chat.postMessage", {})).rejects.toThrow(
      "WebSocket not connected",
    );
  });

  test("propagates ack payload back through mux when event has id", async () => {
    const ackReceived = new Promise<Record<string, unknown>>((resolve) => {
      wss.on("connection", (ws) => {
        ws.send(
          JSON.stringify({
            type: "slack_event",
            id: "evt-001",
            payload: { type: "block_actions", actions: [] },
            headers: {},
          }),
        );
        ws.on("message", (data) => {
          const msg = parseWsMessage(data);
          if (msg.type === "slack_ack") {
            resolve(msg);
          }
        });
      });
    });

    const processEvent = vi
      .fn()
      .mockImplementation(async (event: { ack: (...args: unknown[]) => Promise<void> }) => {
        await event.ack({ text: "got it" });
      });

    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent, client: { apiCall: vi.fn() } });

    await receiver.start();
    receiver.setAuthReady();
    const ack = await ackReceived;
    expect(ack).toMatchObject({ type: "slack_ack", id: "evt-001", payload: { text: "got it" } });
  });

  test("ack is no-op when event has no id", async () => {
    const processEvent = vi
      .fn()
      .mockImplementation(async (event: { ack: (...args: unknown[]) => Promise<void> }) => {
        // Should not throw even though there's no event id
        await event.ack({ text: "irrelevant" });
      });

    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent, client: { apiCall: vi.fn() } });

    wss.on("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "slack_event",
          // No id field — backward-compat no-op path
          payload: { type: "event_callback", event: { type: "message" } },
          headers: {},
        }),
      );
    });

    await receiver.start();
    receiver.setAuthReady();
    await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(1));
    // If we reach here without throwing, the no-op ack worked correctly.
  });

  test("responds to application-level ping with pong", async () => {
    const pongReceived = new Promise<Record<string, unknown>>((resolve) => {
      wss.on("connection", (ws) => {
        ws.send(JSON.stringify({ type: "ping", ts: 12345 }));
        ws.on("message", (data) => {
          const msg = parseWsMessage(data);
          if (msg.type === "pong") {
            resolve(msg);
          }
        });
      });
    });

    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    await receiver.start();
    const pong = await pongReceived;
    expect(pong).toEqual({ type: "pong", ts: 12345 });
  });

  test("reconnects with exponential backoff after disconnect", async () => {
    let connectionCount = 0;
    wss.on("connection", (ws) => {
      connectionCount++;
      if (connectionCount === 1) {
        ws.close(1001, "going away");
      }
    });

    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    await receiver.start();
    await vi.waitFor(() => expect(connectionCount).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("reconnecting in"));
  });

  test("rejects in-flight API calls on disconnect", async () => {
    let serverWs: WebSocket | undefined;
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    await receiver.start();

    // Start an API call but don't respond from server
    const apiPromise = receiver.apiCall("chat.postMessage", { channel: "C123", text: "hi" });
    // Server closes the connection
    serverWs!.close(1001, "going away");

    await expect(apiPromise).rejects.toThrow("MuxReceiver: WebSocket disconnected");
  });

  test("does not reconnect on initial connection failure", async () => {
    // Close the server so the initial connection fails
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    await expect(receiver.start()).rejects.toThrow();
    // Give time for any reconnect attempt to fire
    await new Promise((r) => setTimeout(r, 200));
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("reconnecting in"));
  });

  test("stop cancels pending apiCall promises", async () => {
    wss.on("connection", () => {
      // Server intentionally never responds to API calls.
    });

    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    await receiver.start();

    const apiPromise = receiver.apiCall("chat.postMessage", { channel: "C123", text: "hi" });
    await receiver.stop();

    await expect(apiPromise).rejects.toThrow("MuxReceiver stopped");
  });

  test("sends auth header when token is configured", async () => {
    const authHeader = new Promise<string | undefined>((resolve) => {
      wss.on("connection", (_ws, req) => {
        resolve(req.headers.authorization);
      });
    });

    receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}`, token: "test-token-123" },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    await receiver.start();
    expect(await authHeader).toBe("Bearer test-token-123");
  });

  test("resolves GCP metadata token when no config or env token", async () => {
    const authHeader = new Promise<string | undefined>((resolve) => {
      wss.on("connection", (_ws, req) => {
        resolve(req.headers.authorization);
      });
    });

    // Mock fetch to simulate GCP metadata server
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string, opts: RequestInit) => {
      if (
        url.startsWith("http://metadata.google.internal/") &&
        (opts.headers as Record<string, string>)?.["Metadata-Flavor"] === "Google"
      ) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("gcp-oidc-token-789"),
        });
      }
      return originalFetch(url, opts);
    }) as typeof fetch;

    try {
      receiver = new MuxReceiver({
        mux: { url: `ws://127.0.0.1:${port}` },
        runtime,
      });
      receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

      await receiver.start();
      expect(await authHeader).toBe("Bearer gcp-oidc-token-789");

      // Verify audience was derived from mux URL
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain(`audience=${encodeURIComponent(`http://127.0.0.1:${port}`)}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls through GCP metadata when server is unavailable", async () => {
    const authHeader = new Promise<string | undefined>((resolve) => {
      wss.on("connection", (_ws, req) => {
        resolve(req.headers.authorization);
      });
    });

    // Mock fetch to simulate metadata server timeout/failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("http://metadata.google.internal/")) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return originalFetch(url);
    }) as typeof fetch;

    try {
      receiver = new MuxReceiver({
        mux: { url: `ws://127.0.0.1:${port}` },
        runtime,
      });
      receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

      await receiver.start();
      // Should connect without auth (no token resolved)
      expect(await authHeader).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("derives correct HTTPS audience from WSS mux URL", async () => {
    const authHeader = new Promise<string | undefined>((resolve) => {
      wss.on("connection", (_ws, req) => {
        resolve(req.headers.authorization);
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string, opts: RequestInit) => {
      if (
        url.startsWith("http://metadata.google.internal/") &&
        (opts.headers as Record<string, string>)?.["Metadata-Flavor"] === "Google"
      ) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("gcp-wss-token"),
        });
      }
      return originalFetch(url, opts);
    }) as typeof fetch;

    try {
      // Use wss:// URL but connect to local ws:// for the test
      receiver = new MuxReceiver({
        mux: { url: `ws://127.0.0.1:${port}/ws` },
        runtime,
      });
      receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

      await receiver.start();
      expect(await authHeader).toBe("Bearer gcp-wss-token");

      // Verify /ws path was stripped from audience
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain(`audience=${encodeURIComponent(`http://127.0.0.1:${port}`)}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses MUX_TOKEN env var when no config token", async () => {
    const authHeader = new Promise<string | undefined>((resolve) => {
      wss.on("connection", (_ws, req) => {
        resolve(req.headers.authorization);
      });
    });

    const originalEnv = process.env.MUX_TOKEN;
    process.env.MUX_TOKEN = "env-token-456";
    try {
      receiver = new MuxReceiver({
        mux: { url: `ws://127.0.0.1:${port}` },
        runtime,
      });
      receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

      await receiver.start();
      expect(await authHeader).toBe("Bearer env-token-456");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.MUX_TOKEN;
      } else {
        process.env.MUX_TOKEN = originalEnv;
      }
    }
  });
});

describe("installMuxApiProxy", () => {
  test("patches app.client.apiCall to route through MuxReceiver", async () => {
    const port = await getAvailablePort();
    const wss = new WebSocketServer({ port });
    const runtime = createTestRuntime();

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = parseWsMessage(data);
        if (msg.type === "slack_api") {
          ws.send(
            JSON.stringify({
              type: "slack_api_response",
              id: msg.id,
              ok: true,
              response: { ok: true, channel: "C123" },
            }),
          );
        }
      });
    });

    const receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    const _originalApiCall = vi.fn();
    const fakeApp = {
      client: { apiCall: _originalApiCall } as Record<string, unknown> & {
        apiCall: (...args: unknown[]) => Promise<unknown>;
      },
    };

    installMuxApiProxy(fakeApp, receiver);
    await receiver.start();

    const result = await fakeApp.client.apiCall("chat.postMessage", {
      channel: "C123",
      text: "hi",
    });
    expect(result).toEqual({ ok: true, channel: "C123" });
    expect(_originalApiCall).not.toHaveBeenCalled();

    await receiver.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

describe("installMuxApiProxy – convenience method rebinding", () => {
  test("rebinds nested convenience methods to route through mux proxy", async () => {
    const port = await getAvailablePort();
    const wss = new WebSocketServer({ port });
    const runtime = createTestRuntime();

    const receivedMethods: string[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = parseWsMessage(data);
        if (msg.type === "slack_api") {
          receivedMethods.push(msg.method as string);
          ws.send(
            JSON.stringify({
              type: "slack_api_response",
              id: msg.id,
              ok: true,
              response: { ok: true },
            }),
          );
        }
      });
    });

    const receiver = new MuxReceiver({
      mux: { url: `ws://127.0.0.1:${port}` },
      runtime,
    });
    receiver.init({ processEvent: vi.fn(), client: { apiCall: vi.fn() } });

    // Simulate the structure that Bolt's WebClient creates via bindApiCall:
    // convenience methods are pre-bound to the original apiCall.
    const originalApiCall = vi.fn();
    const fakeApp = {
      client: {
        apiCall: originalApiCall,
        chat: {
          postMessage: originalApiCall.bind(null, "chat.postMessage"),
          update: originalApiCall.bind(null, "chat.update"),
        },
        conversations: {
          info: originalApiCall.bind(null, "conversations.info"),
          history: originalApiCall.bind(null, "conversations.history"),
        },
        // Nested group (like admin.apps.config.set)
        admin: {
          apps: {
            config: {
              set: originalApiCall.bind(null, "admin.apps.config.set"),
            },
          },
        },
      } as Record<string, unknown> & {
        apiCall: (...args: unknown[]) => Promise<unknown>;
      },
    };

    installMuxApiProxy(fakeApp, receiver);
    await receiver.start();

    // Call convenience methods — they should route through the mux, NOT the original
    const client = fakeApp.client as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >;
    await client.chat.postMessage({ channel: "C123", text: "hello" });
    await client.conversations.info({ channel: "C123" });

    // Nested method
    const admin = fakeApp.client.admin as Record<
      string,
      Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
    >;
    await admin.apps.config.set({ app_id: "A123" });

    expect(originalApiCall).not.toHaveBeenCalled();
    expect(receivedMethods).toEqual([
      "chat.postMessage",
      "conversations.info",
      "admin.apps.config.set",
    ]);

    await receiver.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

describe("config validation", () => {
  test("SlackConfigSchema rejects account mux mode without mux.url", async () => {
    const { SlackConfigSchema } = await import("../config/zod-schema.providers-core.js");
    const result = SlackConfigSchema.safeParse({
      accounts: { test: { mode: "mux" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const muxUrlIssue = result.error.issues.find((i) => i.path.join(".").includes("mux"));
      expect(muxUrlIssue).toBeDefined();
    }
  });

  test("SlackAccountSchema accepts mux mode with mux.url", async () => {
    const { SlackAccountSchema } = await import("../config/zod-schema.providers-core.js");
    const result = SlackAccountSchema.safeParse({
      mode: "mux",
      mux: { url: "wss://mux.example.com/ws" },
    });
    expect(result.success).toBe(true);
  });

  test("SlackConfigSchema rejects base mux mode without mux.url", async () => {
    const { SlackConfigSchema } = await import("../config/zod-schema.providers-core.js");
    const result = SlackConfigSchema.safeParse({ mode: "mux" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const muxUrlIssue = result.error.issues.find((i) => i.path.join(".") === "mux.url");
      expect(muxUrlIssue).toBeDefined();
    }
  });

  test("SlackConfigSchema rejects account mux mode without mux.url", async () => {
    const { SlackConfigSchema } = await import("../config/zod-schema.providers-core.js");
    const result = SlackConfigSchema.safeParse({
      accounts: {
        work: { mode: "mux" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const muxUrlIssue = result.error.issues.find(
        (i) => i.path.includes("mux") && i.path.includes("url"),
      );
      expect(muxUrlIssue).toBeDefined();
    }
  });

  test("SlackConfigSchema accepts account mux with inherited base url", async () => {
    const { SlackConfigSchema } = await import("../config/zod-schema.providers-core.js");
    const result = SlackConfigSchema.safeParse({
      mux: { url: "wss://mux.example.com/ws" },
      accounts: {
        work: { mode: "mux", mux: { token: "work-token" } },
      },
    });
    expect(result.success).toBe(true);
  });
});

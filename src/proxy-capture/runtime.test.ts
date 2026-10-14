import fs from "node:fs";
import { Headers as UndiciHeaders } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import type { DebugProxySettings } from "./env.js";
import {
  captureHttpExchange,
  captureWsEvent,
  finalizeDebugProxyCapture,
  initializeDebugProxyCapture,
  type DebugProxyCaptureRuntimeDeps,
} from "./runtime.js";

type StoreCall = { name: string; args: unknown[] };

const settings: DebugProxySettings = {
  enabled: true,
  required: false,
  dbPath: "/tmp/openclaw-proxy-runtime-test.sqlite",
  blobDir: "/tmp/openclaw-proxy-runtime-test-blobs",
  certDir: "/tmp/openclaw-proxy-runtime-test-certs",
  sessionId: "runtime-test-session",
  sourceProcess: "runtime-test",
};

const fetchTarget: typeof globalThis = {
  ...globalThis,
  fetch: async () => new Response("{}", { status: 200 }),
};

const events: Record<string, unknown>[] = [];
const calls: StoreCall[] = [];
const store = {
  upsertSession: (...args: unknown[]) => {
    calls.push({ name: "upsertSession", args });
  },
  endSession: (...args: unknown[]) => {
    calls.push({ name: "endSession", args });
  },
  recordEvent: (event: Record<string, unknown>) => {
    events.push(event);
  },
};

const deps: DebugProxyCaptureRuntimeDeps = {
  fetchTarget,
  getStore: () => store,
  closeStore: () => {
    calls.push({ name: "closeStore", args: [] });
  },
  persistEventPayload: (
    _store: unknown,
    payload: { data?: Buffer | string | null; contentType?: string },
  ) => ({
    contentType: payload.contentType,
    ...(typeof payload.data === "string"
      ? { dataText: payload.data }
      : Buffer.isBuffer(payload.data)
        ? { dataText: payload.data.toString("utf8") }
        : {}),
  }),
  safeJsonString: (value: unknown) => (value == null ? undefined : JSON.stringify(value)),
};

const ONE_MIB = 1024 * 1024;

// Builds a chunked (no Content-Length) response that streams `totalBytes` so the
// bounded body reader exercises its real overflow/cancel path on the clone.
function makeStreamingResponse(totalBytes: number, headers: Record<string, string> = {}): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(ONE_MIB, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/octet-stream", ...headers },
  });
}

async function waitForResponseSettled(): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (events.some((event) => event.kind === "response" || event.kind === "error")) {
      return;
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe("debug proxy runtime", () => {
  beforeEach(() => {
    finalizeDebugProxyCapture(settings, deps);
    // Each test owns a fresh injected store binding, including its admission.
    deps.getStore = () => store;
    events.length = 0;
    calls.length = 0;
    resetSecretRedactionRegistryForTest();
    fetchTarget.fetch = async () => new Response("{}", { status: 200 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["initialization", () => initializeDebugProxyCapture("test", undefined, deps)],
    ["finalization", () => finalizeDebugProxyCapture(undefined, deps)],
    [
      "HTTP exchange",
      () =>
        captureHttpExchange(
          { url: "https://example.test", method: "GET", response: new Response(null) },
          undefined,
          deps,
        ),
    ],
  ] as const)("does not discover capture paths for disabled %s", (_name, capture) => {
    // Exercise production path discovery rather than the test-only state-dir shortcut.
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", undefined);
    const existsSync = vi.spyOn(fs, "existsSync");
    const originalFetch = fetchTarget.fetch;

    capture();

    expect(existsSync).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    expect(fetchTarget.fetch).toBe(originalFetch);
  });

  it("observes environment changes while explicit capture settings remain authoritative", () => {
    const frame = {
      url: "wss://example.test",
      direction: "outbound",
      kind: "ws-frame",
      flowId: "capture-toggle",
      payload: "{}",
    } as const;
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", "ambient-capture");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    captureWsEvent(frame, undefined, deps);
    expect(events).toEqual([]);

    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    captureWsEvent(frame, undefined, deps);
    expect(events.map((event) => event.sessionId)).toEqual(["ambient-capture"]);
    captureWsEvent(frame, { ...settings, enabled: false }, deps);
    expect(events).toHaveLength(1);

    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    captureWsEvent(frame, undefined, deps);
    expect(events).toHaveLength(1);
    captureWsEvent(frame, settings, deps);
    expect(events.map((event) => event.sessionId)).toEqual([
      "ambient-capture",
      "runtime-test-session",
    ]);
  });

  it("normalizes symbol-bearing request headers before calling patched fetch targets", async () => {
    fetchTarget.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-hidden")).toBe("yes");
      return new Response("{}", { status: 200 });
    };
    const headers = { "content-type": "application/json" } as Record<string, string> & {
      [key: symbol]: unknown;
    };
    Object.defineProperty(headers, "x-hidden", {
      value: "yes",
      enumerable: false,
    });
    Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
      value: new Set(["content-type"]),
      enumerable: false,
    });

    initializeDebugProxyCapture("test", settings, deps);
    await fetchTarget.fetch("https://api.example.com/messages#%", {
      method: "POST",
      headers,
      body: "{}",
    });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    finalizeDebugProxyCapture(settings, deps);

    const request = events.find((event) => event.kind === "request");
    expect(JSON.parse(String(request?.headersJson))).toStrictEqual({
      "content-type": "application/json",
      "x-hidden": "yes",
    });
    expect(Object.getOwnPropertySymbols(headers)).toHaveLength(1);
  });

  it("redacts sensitive request and response headers before persistence", async () => {
    const secret = "capture-managed-secret";
    const pathSecret = "capture/path secret";
    registerSecretValueForRedaction(secret);
    registerSecretValueForRedaction(pathSecret);
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: `https://api.example.com/models/${encodeURIComponent(pathSecret)}?key=${encodeURIComponent(secret)}`,
        method: "GET",
        requestHeaders: {
          Authorization: "Bot discord-token",
          Cookie: "sid=session-token",
          "x-api-key": "provider-key",
          "content-type": "application/json",
          "X-Routing-Target": "staging-private-route",
          "x-safe": "visible",
          "X-Managed": `Bearer ${secret}`,
        },
        meta: { sensitiveRequestHeaderNames: ["x-routing-target"] },
        response: new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "sid=response-token",
          },
        }),
      },
      settings,
      deps,
    );
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    finalizeDebugProxyCapture(settings, deps);

    const request = events.find((event) => event.kind === "request");
    expect(request?.path).toBe("/models/%5BREDACTED%5D?key=%5BREDACTED%5D");
    expect(JSON.parse(String(request?.headersJson))).toStrictEqual({
      Authorization: "[REDACTED]",
      Cookie: "[REDACTED]",
      "x-api-key": "[REDACTED]",
      "content-type": "application/json",
      "X-Routing-Target": "[REDACTED]",
      "x-safe": "visible",
      "X-Managed": "Bearer [REDACTED]",
    });
    const response = events.find((event) => event.kind === "response");
    expect(JSON.parse(String(response?.headersJson))).toStrictEqual({
      "content-type": "application/json",
      "set-cookie": "[REDACTED]",
    });
  });

  it("redacts registered values from every persisted WebSocket field", () => {
    const secret = 'mattermost-"capture\\secret\nline';
    registerSecretValueForRedaction(secret);

    captureWsEvent(
      {
        url: `wss://chat.example.test/api/v4/websocket?token=${encodeURIComponent(secret)}`,
        direction: "outbound",
        kind: "ws-frame",
        flowId: "mattermost-auth",
        payload: JSON.stringify({ action: "authentication_challenge", data: { token: secret } }),
        errorText: `failed with ${secret}`,
        meta: { subsystem: "mattermost-websocket", detail: secret },
      },
      settings,
      deps,
    );
    captureWsEvent(
      {
        url: "wss://chat.example.test/api/v4/websocket",
        direction: "inbound",
        kind: "ws-frame",
        flowId: "mattermost-auth",
        payload: Buffer.from(JSON.stringify({ echoedToken: secret })),
      },
      settings,
      deps,
    );

    const [outbound, inbound] = events;
    expect(outbound?.path).toBe("/api/v4/websocket?token=%5BREDACTED%5D");
    expect(outbound?.dataText).toContain('"token":"[REDACTED]"');
    expect(outbound?.errorText).toBe("failed with [REDACTED]");
    expect(JSON.parse(String(outbound?.metaJson))).toStrictEqual({
      subsystem: "mattermost-websocket",
      detail: "[REDACTED]",
    });
    expect(inbound?.dataText).toContain('"echoedToken":"[REDACTED]"');
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(JSON.stringify(secret).slice(1, -1));
  });

  it("redacts registered credential bytes from otherwise non-UTF-8 frames", () => {
    const secret = "binary-frame-capture-secret";
    registerSecretValueForRedaction(secret);
    const payload = Buffer.concat([
      Buffer.from([0xff, 0x00]),
      Buffer.from(secret, "utf8"),
      Buffer.from([0xfe]),
    ]);

    captureWsEvent(
      {
        url: "wss://chat.example.test/api/v4/websocket",
        direction: "outbound",
        kind: "ws-frame",
        flowId: "binary-auth",
        payload,
      },
      settings,
      deps,
    );

    expect(events[0]?.dataText).toBe("[REDACTED BINARY PAYLOAD]");
    expect(events[0]?.dataText).not.toContain(secret);
  });

  it.each([
    ["record", undefined],
    ["Undici Headers", UndiciHeaders],
  ] as const)(
    "redacts registered values from HTTP payloads and metadata with %s",
    async (_name, HeadersConstructor) => {
      const secret = 'http-"capture\\secret\nline';
      const contentTypeSecret = "http-content-type-secret";
      registerSecretValueForRedaction(secret);
      registerSecretValueForRedaction(contentTypeSecret);
      const requestHeaders = { "content-type": `application/json; token=${contentTypeSecret}` };

      captureHttpExchange(
        {
          url: "https://api.example.test/v1/messages",
          method: "POST",
          requestHeaders: HeadersConstructor
            ? new HeadersConstructor(requestHeaders)
            : requestHeaders,
          requestBody: JSON.stringify({ credential: secret }),
          response: new Response(JSON.stringify({ echoedCredential: secret }), {
            status: 200,
            headers: { "content-type": `application/json; token=${contentTypeSecret}` },
          }),
          meta: { credential: secret },
        },
        settings,
        deps,
      );
      await waitForResponseSettled();

      const request = events.find((event) => event.kind === "request");
      const response = events.find((event) => event.kind === "response");
      expect(request?.dataText).toContain('"credential":"[REDACTED]"');
      expect(request?.metaJson).toContain('"credential":"[REDACTED]"');
      expect(request?.contentType).toBe("application/json; token=[REDACTED]");
      expect(response?.dataText).toContain('"echoedCredential":"[REDACTED]"');
      expect(response?.metaJson).toContain('"credential":"[REDACTED]"');
      expect(response?.contentType).toBe("application/json; token=[REDACTED]");
      expect(JSON.stringify(events)).not.toContain(secret);
    },
  );

  it("redacts registered values from failed global-fetch capture events", async () => {
    const secret = "capture-failure/secret";
    const secretUrl = "https://signed.example/v1/callback";
    registerSecretValueForRedaction(secret);
    registerSecretValueForRedaction(secretUrl);
    fetchTarget.fetch = vi.fn(async () => {
      throw new Error(`request failed for ${secret}`);
    }) as typeof fetch;
    initializeDebugProxyCapture("test", settings, deps);

    await expect(fetchTarget.fetch(secretUrl)).rejects.toThrow("request failed");

    const event = events.find((candidate) => candidate.kind === "error");
    expect(event?.host).toBe("redacted.invalid");
    expect(event?.path).toBe("/%5BREDACTED%5D");
    expect(event?.errorText).toBe("request failed for [REDACTED]");
  });

  it("gives up on a stalled response body and lets the caller's cancellation settle", async () => {
    vi.useFakeTimers();
    try {
      initializeDebugProxyCapture("test", settings, deps);
      // Headers plus one chunk, then the remote stops without EOF. clone() tees
      // the body, and a tee branch cancels only once both branches cancel or the
      // source ends — so a capture read with no idle bound holds the caller's
      // branch open for as long as the remote stays silent.
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      // Capture clones internally, exactly as the patched fetch does, so the
      // caller keeps the branch this response already holds. Cloning here first
      // would leave a third, unread branch that no one ever cancels.
      captureHttpExchange(
        { url: "https://api.example.com/stalls", method: "GET", response: upstream },
        settings,
        deps,
      );

      let cancellationSettled = false;
      void upstream.body
        ?.cancel()
        .catch(() => undefined)
        .finally(() => {
          cancellationSettled = true;
        });

      await vi.advanceTimersByTimeAsync(9_000);
      expect(cancellationSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(cancellationSettled).toBe(true));

      const response = events.find((event) => event.kind === "response");
      expect(response?.status).toBe(200);
      expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "stalled" });
      expect(response?.dataText).toBe("partial");
      expect(events.some((event) => event.kind === "error")).toBe(false);
    } finally {
      vi.useRealTimers();
      finalizeDebugProxyCapture(settings, deps);
    }
  });

  it("skips capturing the body when Content-Length exceeds the cap", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: "https://api.openai.com/v1/files/big",
        method: "GET",
        response: new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(32 * 1024 * 1024),
          },
        }),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response).toBeDefined();
    expect(response?.status).toBe(200);
    // Metadata is recorded, but the oversized body is never buffered/persisted.
    expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "too-large" });
    expect(response).not.toHaveProperty("dataText");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("skips capturing decimal Content-Length values above the safe integer range", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: "https://api.openai.com/v1/files/huge",
        method: "GET",
        response: new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "9007199254740993",
          },
        }),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "too-large" });
    expect(response).not.toHaveProperty("dataText");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("streams non-decimal Content-Length values through the body cap", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: "https://api.openai.com/v1/files/small",
        method: "GET",
        response: new Response("captured", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-length": "1e9",
          },
        }),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response).toBeDefined();
    expect(response?.dataText).toBe("captured");
    expect(response?.metaJson).toBeUndefined();
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("fails closed on chunked responses that stream past the cap", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    // 20 MiB streamed without a Content-Length header: the bounded reader must
    // cancel the clone at the cap and record metadata instead of buffering it.
    captureHttpExchange(
      {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        response: makeStreamingResponse(20 * ONE_MIB),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response).toBeDefined();
    expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "too-large" });
    expect(response).not.toHaveProperty("dataText");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("records Response-like status metadata when the Headers API is absent", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: "https://api.openai.com/v1/no-headers-api",
        method: "GET",
        response: { status: 204 } as unknown as Response,
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response?.status).toBe(204);
    expect(response?.contentType).toBeUndefined();
    expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "unavailable" });
  });
});

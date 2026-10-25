import fs from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Headers as UndiciHeaders } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const storeCall = vi.fn<(...args: unknown[]) => void>();
const store = {
  upsertSession: storeCall,
  endSession: storeCall,
  recordEvent: (event: Record<string, unknown>) => {
    events.push(event);
  },
};

const deps: DebugProxyCaptureRuntimeDeps = {
  fetchTarget,
  getStore: () => store,
  closeStore: storeCall,
  persistEventPayload: (_store, payload) => ({
    contentType: payload.contentType,
    ...(payload.data == null ? {} : { dataText: payload.data.toString() }),
  }),
  safeJsonString: (value: unknown) => (value == null ? undefined : JSON.stringify(value)),
};

const ONE_MIB = 1024 * 1024;

// Builds a chunked (no Content-Length) response that streams `totalBytes` so the
// bounded body reader exercises its real overflow/cancel path on the clone.
function makeStreamingResponse(totalBytes: number): Response {
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
  return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
}

async function waitForResponseSettled(): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (events.some((event) => event.kind === "response" || event.kind === "error")) {
      return;
    }
    await nextTurn();
  }
}

function captureHttp(params: Parameters<typeof captureHttpExchange>[0]) {
  captureHttpExchange(params, settings, deps);
}

function makeResponse(body = "{}", headers: Record<string, string> = {}) {
  return new Response(body, { headers: { "content-type": "application/json", ...headers } });
}

function captureFrame(params: Partial<Parameters<typeof captureWsEvent>[0]>) {
  captureWsEvent(
    {
      url: "wss://chat.example.test/api/v4/websocket",
      direction: "outbound",
      kind: "ws-frame",
      flowId: "mattermost-auth",
      ...params,
    },
    settings,
    deps,
  );
}

async function captureResponse(response: Response) {
  initializeDebugProxyCapture("test", settings, deps);
  captureHttp({ url: "https://api.example.test/response", method: "GET", response });
  await waitForResponseSettled();
  finalizeDebugProxyCapture(settings, deps);
  return events.find((event) => event.kind === "response");
}

async function expectTooLarge(response: Response) {
  const captured = await captureResponse(response);
  expect(captured).toMatchObject({ status: 200 });
  expect(JSON.parse(String(captured?.metaJson))).toMatchObject({ bodyCapture: "too-large" });
  expect(captured).not.toHaveProperty("dataText");
  expect(events.some((event) => event.kind === "error")).toBe(false);
}

beforeEach(() => {
  finalizeDebugProxyCapture(settings, deps);
  // Each test owns a fresh injected store binding, including its admission.
  deps.getStore = () => store;
  events.length = 0;
  storeCall.mockClear();
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
  expect(storeCall).not.toHaveBeenCalled();
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

it("redacts sensitive request and response headers before persistence", async () => {
  const secret = "capture-managed-secret";
  const pathSecret = "capture/path secret";
  registerSecretValueForRedaction(secret);
  registerSecretValueForRedaction(pathSecret);
  initializeDebugProxyCapture("test", settings, deps);
  captureHttp({
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
    response: makeResponse("{}", { "set-cookie": "sid=response-token" }),
  });
  await nextTurn();
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

  captureFrame({
    url: `wss://chat.example.test/api/v4/websocket?token=${encodeURIComponent(secret)}`,
    payload: JSON.stringify({ action: "authentication_challenge", data: { token: secret } }),
    errorText: `failed with ${secret}`,
    meta: { subsystem: "mattermost-websocket", detail: secret },
  });
  captureFrame({
    direction: "inbound",
    payload: Buffer.from(JSON.stringify({ echoedToken: secret })),
  });

  const [outbound, inbound] = events;
  expect(outbound?.path).toBe("/api/v4/websocket?token=%5BREDACTED%5D");
  expect(outbound?.dataText).toContain('"token":"[REDACTED]"');
  expect(outbound?.errorText).toBe("failed with [REDACTED]");
  expect(JSON.parse(String(outbound?.metaJson))).toStrictEqual({
    subsystem: "mattermost-websocket",
    detail: "[REDACTED]",
  });
  expect(inbound?.dataText).toContain('"echoedToken":"[REDACTED]"');
  expect(JSON.stringify(events)).not.toContain(JSON.stringify(secret).slice(1, -1));
});

it("redacts registered credential bytes from otherwise non-UTF-8 frames", () => {
  const secret = "binary-frame-capture-secret";
  registerSecretValueForRedaction(secret);
  const payload = Buffer.from([0xff, 0x00, ...Buffer.from(secret, "utf8"), 0xfe]);

  captureFrame({ flowId: "binary-auth", payload });

  expect(events[0]?.dataText).toBe("[REDACTED BINARY PAYLOAD]");
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

    captureHttp({
      url: "https://api.example.test/v1/messages",
      method: "POST",
      requestHeaders: HeadersConstructor ? new HeadersConstructor(requestHeaders) : requestHeaders,
      requestBody: JSON.stringify({ credential: secret }),
      response: makeResponse(JSON.stringify({ echoedCredential: secret }), {
        "content-type": `application/json; token=${contentTypeSecret}`,
      }),
      meta: { credential: secret },
    });
    await waitForResponseSettled();

    const request = events.find((event) => event.kind === "request");
    const response = events.find((event) => event.kind === "response");
    for (const [event, field] of [
      [request, "credential"],
      [response, "echoedCredential"],
    ] as const) {
      expect(event?.dataText).toContain(`"${field}":"[REDACTED]"`);
      expect(event?.metaJson).toContain('"credential":"[REDACTED]"');
      expect(event?.contentType).toBe("application/json; token=[REDACTED]");
    }
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
    // A stalled tee holds caller cancellation open until capture cancels too.
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    // Capture must own the only clone; a third unread branch would never cancel.
    captureHttp({ url: "https://api.example.test/stalls", method: "GET", response: upstream });

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

it.each([
  ["large length", () => makeResponse("{}", { "content-length": "33554432" })],
  ["unsafe length", () => makeResponse("{}", { "content-length": "9007199254740993" })],
  ["chunked body", () => makeStreamingResponse(20 * ONE_MIB)],
] as const)("omits body for %s", async (_name, createResponse) => {
  await expectTooLarge(createResponse());
});

it("streams non-decimal Content-Length values through the body cap", async () => {
  const captured = await captureResponse(
    makeResponse("captured", { "content-type": "text/plain", "content-length": "1e9" }),
  );
  expect(captured).toMatchObject({ dataText: "captured" });
  expect(captured?.metaJson).toBeUndefined();
  expect(events.some((event) => event.kind === "error")).toBe(false);
});

it("records Response-like status metadata when the Headers API is absent", async () => {
  const response = await captureResponse({ status: 204 } as unknown as Response);
  expect(response?.status).toBe(204);
  expect(response?.contentType).toBeUndefined();
  expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "unavailable" });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "../agents/provider-request-config.js";
import type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
import { evaluateDecisionHttp, type DecisionHttpRoute } from "./decisions-http-runtime.js";

type GuardedRequest = {
  url: string;
  maxRedirects?: number;
  mode?: string;
  signal: AbortSignal;
  init: RequestInit;
};
const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(request: GuardedRequest) => Promise<Response>>(),
  release: vi.fn(async () => {}),
}));
vi.mock("./provider-http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-http.js")>()),
  fetchWithProviderHttpGuard: async (request: GuardedRequest) => ({
    response: await mocks.fetch(request),
    release: mocks.release,
  }),
}));

const KEY = "synthetic-decision-key";
const ok = { status: "ok" } as const;

function context(extra: Partial<DecisionProviderContextV2> = {}): DecisionProviderContextV2 {
  return {
    model: { provider: "fixture", id: "fixture-model", name: "Fixture" },
    auth: { mode: "api-key", apiKey: KEY },
    config: {},
    isAdmissible: () => true,
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 30_000,
    ...extra,
  };
}

function evaluate(
  extra: Partial<DecisionProviderContextV2> = {},
  route: Partial<DecisionHttpRoute<typeof ok>> = {},
) {
  return evaluateDecisionHttp(context(extra), {
    provider: "fixture",
    baseUrl: "https://decisions.example.test/v1/",
    endpointPath: "decide",
    body: '{"question":"fixture"}',
    decode: () => ok,
    ...route,
  });
}

const request = (index = 0) => mocks.fetch.mock.calls[index]![0];

beforeEach(() => {
  mocks.fetch.mockReset().mockResolvedValue(Response.json({ answer: true }));
  mocks.release.mockClear();
  vi.stubEnv("HTTPS_PROXY", "");
});
afterEach(() => vi.unstubAllEnvs());

it("posts JSON under the configured prefix with bearer auth and no redirects", async () => {
  await expect(evaluate()).resolves.toEqual(ok);
  const sent = request();
  expect(sent).toMatchObject({ url: "https://decisions.example.test/v1/decide", maxRedirects: 0 });
  expect(sent.init.method).toBe("POST");
  expect(Object.fromEntries(new Headers(sent.init.headers))).toMatchObject({
    authorization: `Bearer ${KEY}`,
    "content-type": "application/json",
    accept: "application/json",
  });
  expect(mocks.release).toHaveBeenCalledOnce();

  await evaluate({}, { body: undefined, authHeaders: (key) => ({ "x-api-key": key }) });
  const get = request(1);
  expect(get.init.method).toBe("GET");
  const headers = new Headers(get.init.headers);
  expect([headers.get("x-api-key"), headers.has("authorization")]).toEqual([KEY, false]);
  expect(headers.has("content-type")).toBe(false);
});

it("routes through the trusted env proxy when one applies", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://proxy.example.test:3128");
  await evaluate();
  expect(request().mode).toBe("trusted_env_proxy");
});

it("never restores a bearer after a prepared auth override replaces it", async () => {
  const model = attachModelProviderRequestTransport(
    { ...context().model, headers: { "X-Custom-Auth": "override-secret" } },
    { auth: { mode: "header", headerName: "X-Custom-Auth", value: "override-secret" } },
  );
  await evaluate({ model });
  const headers = new Headers(request().init.headers);
  expect([headers.get("x-custom-auth"), headers.has("authorization")]).toEqual([
    "override-secret",
    false,
  ]);
});

it("applies per-request headers without treating their values as credentials", async () => {
  // Configured on the model and on the prepared request; the body-specific value wins.
  const model = attachModelProviderRequestTransport(
    { ...context().model, headers: { "X-Opt-In": "false", "X-Stale": "1" } },
    { headers: { "X-Opt-In": "false" } },
  );
  mocks.fetch.mockResolvedValue(Response.json({ flag: true }));
  await expect(
    evaluate({ model }, { requestHeaders: { "x-opt-in": "true", "x-stale": null } }),
  ).resolves.toEqual(ok);
  const headers = new Headers(request().init.headers);
  expect([headers.get("x-opt-in"), headers.has("x-stale")]).toEqual(["true", false]);
});

it.each([
  [401, {}, { reason: "authentication" }],
  [403, {}, { reason: "authentication" }],
  [429, { "retry-after": "2" }, { reason: "rate-limited", retryAfterMs: 2000 }],
  [
    429,
    { "retry-after-ms": "250", "retry-after": "9" },
    { reason: "rate-limited", retryAfterMs: 250 },
  ],
  [400, {}, { reason: "unsupported-input" }],
  [413, {}, { reason: "unsupported-input" }],
  [422, {}, { reason: "unsupported-input" }],
  [500, {}, { reason: "transport" }],
])("maps HTTP %i without reading the body", async (status, headers, outcome) => {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start: (controller) => controller.enqueue(new Uint8Array([1])),
    cancel,
  });
  mocks.fetch.mockResolvedValue(new Response(body, { status, headers }));
  await expect(evaluate()).resolves.toEqual({ status: "unavailable", ...outcome });
  expect(cancel).toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledOnce();
});

it("releases a capture tee when an error body is cancelled", async () => {
  const nativeCancel = vi.fn();
  const [consumer, capture] = new ReadableStream(
    { cancel: nativeCancel },
    { highWaterMark: 0 },
  ).tee();
  // Debug capture keeps a second branch open; only release ends it.
  mocks.release.mockImplementationOnce(() => capture.cancel());
  mocks.fetch.mockResolvedValue(new Response(consumer, { status: 401 }));
  await expect(evaluate()).resolves.toEqual({ status: "unavailable", reason: "authentication" });
  expect(nativeCancel).toHaveBeenCalledOnce();
  expect(mocks.release).toHaveBeenCalledOnce();
});

it("applies a provider status quirk before the shared mapping", async () => {
  mocks.fetch.mockResolvedValue(
    new Response(null, { status: 529, headers: { "retry-after": "1" } }),
  );
  await expect(
    evaluate({}, { statusReason: (status) => (status === 529 ? "rate-limited" : undefined) }),
  ).resolves.toEqual({ status: "unavailable", reason: "rate-limited", retryAfterMs: 1000 });
});

it.each([
  ["a reflected credential", () => Response.json({ echo: KEY }), {}],
  ["malformed JSON", () => new Response("{"), {}],
  ["an oversized body", () => Response.json({ pad: "x".repeat(64) }), { maxResponseBytes: 32 }],
  [
    "a decoder failure",
    () => Response.json({}),
    {
      decode: () => {
        throw new Error("bad shape");
      },
    },
  ],
])("rejects %s as an invalid response and releases", async (_label, response, route) => {
  mocks.fetch.mockResolvedValue(response());
  await expect(evaluate({}, route)).resolves.toEqual({
    status: "unavailable",
    reason: "invalid-response",
  });
  expect(mocks.release).toHaveBeenCalledOnce();
});

it.each([
  ["no credential", { auth: { mode: "api-key" as const } }, "credentials-unavailable"],
  [
    "an OAuth credential",
    { auth: { mode: "oauth" as const, apiKey: KEY } },
    "credentials-unavailable",
  ],
  ["an expired deadline", { deadlineMonotonicMs: performance.now() - 1 }, "transport"],
  ["a closed admission", { isAdmissible: () => false }, "transport"],
])("sends nothing with %s", async (_label, extra, reason) => {
  await expect(evaluate(extra)).resolves.toEqual({ status: "unavailable", reason });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("rejects a base URL with a query, a fragment or a non-HTTP scheme", async () => {
  for (const baseUrl of [
    "https://example.test?x=1",
    "https://example.test#x",
    "ftp://example.test",
  ]) {
    await expect(evaluate({}, { baseUrl })).resolves.toEqual({
      status: "unavailable",
      reason: "transport",
    });
  }
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("checks admission once when the request starts and passes authority errors through", async () => {
  const isAdmissible = vi.fn(() => true);
  await evaluate({ isAdmissible });
  expect(isAdmissible).toHaveBeenCalledOnce();

  const revoked = new Error("grant revoked");
  await expect(
    evaluate({
      isAdmissible: () => {
        throw revoked;
      },
    }),
  ).rejects.toBe(revoked);
  expect(mocks.fetch).toHaveBeenCalledOnce();
});

it("passes caller cancellation through instead of reporting transport failure", async () => {
  const controller = new AbortController();
  mocks.fetch.mockImplementation(async () => {
    controller.abort(new Error("caller cancelled"));
    throw new Error("socket closed");
  });
  await expect(evaluate({ signal: controller.signal })).rejects.toThrow("caller cancelled");
  mocks.fetch.mockRejectedValue(new Error("socket closed"));
  await expect(evaluate()).resolves.toEqual({ status: "unavailable", reason: "transport" });
});

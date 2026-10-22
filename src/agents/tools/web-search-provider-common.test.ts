import { afterEach, expect, it, vi } from "vitest";
import { UnresolvedSecretInputError } from "../../config/types.secrets.js";
import { redactLogRecordForTransport, redactToolPayloadText } from "../../logging/redact.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { withEnv } from "../../test-utils/env.js";
import {
  postTrustedWebToolsJson as postJson,
  readWebSearchApiKey as readKey,
  readWebSearchQueryAndCount as readQuery,
  throwWebSearchApiError as throwApiError,
} from "./web-search-provider-common.js";

const realFetch = globalThis.fetch;
const requestDefaults = {
  url: "https://search.example.com/search",
  timeoutSeconds: 5,
  apiKey: "s7Key",
  body: { query: "test" },
  errorLabel: "Search",
  extraHeaders: { authorization: "Bearer synthetic-stale-key" },
};
// Only routing is injected; the guarded owner consumes the real HTTP response.
async function requestSearch(
  [status, body, phrase = ""]: [status: number, body: string, phrase?: string],
  params: Partial<Parameters<typeof postJson>[0]> = {},
  received?: () => void,
) {
  let authorization: string | undefined;
  let result: unknown;
  await withServer(
    (request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(status, phrase).write(body);
      if (!received) {
        response.end(); // Cancellation is tested with the body still open.
      }
    },
    async (baseUrl) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const response = await realFetch(baseUrl, init);
          received?.();
          return response;
        }),
      );
      result = await postJson({ ...requestDefaults, ...params }, (response) =>
        response.json(),
      ).catch((cause: unknown) => cause);
    },
  );
  return { result, authorization };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const readCredential = (value: unknown) => readKey(value, "test.apiKey", ["SEARCH_A", "SEARCH_B"]);
it.each([
  [" configured ", "  primary  ", "configured"],
  [undefined, "  primary  ", "primary"],
  [" ", " ", "secondary"],
])("resolves credential %s with primary %s to %s", (value, primary, expected) => {
  withEnv({ SEARCH_A: primary, SEARCH_B: "secondary" }, () => {
    expect(readCredential(value)).toBe(expected);
  });
});

it.each(["env", "file", "exec"] as const)("rejects unresolved %s refs", (source) => {
  withEnv({ SEARCH_A: "ambient" }, () => {
    const ref = { source, provider: "default", id: "TEST_SEARCH_REFERENCE" };
    expect(() => readCredential(ref)).toThrow(UnresolvedSecretInputError);
  });
});

it("reads a required query and keeps count fallback resolution with the caller", () => {
  const args = { query: "  test  ", count: 2 };
  expect(readQuery(args, { maxResults: 7 })).toEqual({ query: "test", count: 2 });
  expect(readQuery({ query: "test" }, { maxResults: 7 })).toEqual({ query: "test", count: 7 });
  expect(readQuery({ query: "test" })).toEqual({ query: "test", count: undefined });
  expect(() => readQuery({})).toThrow("query required");
});

it.each([
  ["short body credential", "s7Key", "rejected $key", "", undefined, "rejected ***"],
  ["short reason credential", "s7Key", "", "rejected $key", undefined, "rejected ***"],
  ["bearer reflection", "synthetic-web-key-long", "Bearer $key", "", undefined, "***"],
  ["truncated credential", "synthetic-web-key-long", "rejected $key", "", 15, "rejected ***"],
  ["ordinary detail", "s7Key", "quota exceeded", "", undefined, "quota exceeded"],
] as const)("redacts %s", async (_, apiKey, body, phrase, maxErrorBytes, expected) => {
  const { result: error, authorization } = await requestSearch(
    [401, body.replace("$key", apiKey), phrase.replace("$key", apiKey)],
    { apiKey, maxErrorBytes },
  );
  expect(authorization).toBe(`Bearer ${apiKey}`);
  const message = `Search API error (401): ${expected}`;
  expect(error).toMatchObject({ message, status: 401, statusCode: 401 });
  const diagnostic = redactLogRecordForTransport({ error: String(error) });
  expect(diagnostic).toEqual({ error: `ProviderHttpError: ${message}` });
  expect(String(diagnostic.error)).not.toContain(apiKey);
});

it("preserves caller cancellation after error headers arrive", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic caller cancellation");
  const { result } = await requestSearch(
    [401, "partial diagnostic"],
    { signal: controller.signal },
    () => controller.abort(reason),
  );
  expect(result).toBe(reason);
});

it("keeps successful responses and existing two-argument SDK calls usable", async () => {
  expect(redactToolPayloadText("Bearer tokens")).toBe("Bearer tokens");
  const { result } = await requestSearch([200, '{"answer":"Bearer tokens"}']);
  expect(result).toEqual({ answer: "Bearer tokens" });
  const failure = throwApiError(new Response("quota exceeded", { status: 429 }), "Search");
  await expect(failure).rejects.toThrow("Search API error (429): quota exceeded");
});

it("honors the reader TTL while preserving the shipped one-argument reader", async () => {
  const cache = await import("./web-search-provider-common.js");
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const key = "query:reader-ttl";
  cache.writeCachedSearchPayload(key, { text: "original" }, 900_000);
  expect(cache.readCachedSearchPayload(key, 0)).toBeUndefined();
  cache.writeCachedSearchPayload(key, { text: "disabled" }, 0);
  clock.mockReturnValue(61_000);
  expect(cache.readCachedSearchPayload(key, 60_000)).toBeUndefined();
  expect(cache.readCachedSearchPayload(key)).toEqual({ text: "original", cached: true });
  clock.mockReturnValue(901_001);
  expect(cache.readCachedSearchPayload(key)).toBeUndefined();
});

it("keeps cache entries module-local instead of exposing them on a global symbol", async () => {
  vi.resetModules();
  const symbol = Symbol.for("openclaw.web-search.cache");
  Reflect.deleteProperty(globalThis, symbol);
  const module = await import("./web-search-provider-common.js");
  const cacheKey = "query:test";
  module.writeCachedSearchPayload(cacheKey, { ok: true }, 60_000);

  expect(module.readCachedSearchPayload(cacheKey)).toEqual({ ok: true, cached: true });
  expect(Reflect.get(globalThis, symbol)).toBeUndefined();
});

import { afterEach, expect, it, vi } from "vitest";
import { UnresolvedSecretInputError } from "../../config/types.secrets.js";
import { redactLogRecordForTransport, redactToolPayloadText } from "../../logging/redact.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { withEnv } from "../../test-utils/env.js";
import {
  postTrustedWebToolsJson as postJson,
  readWebSearchApiKey as readKey,
  readWebSearchQueryAndCount as readQuery,
  throwWebSearchApiError,
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
  body: string,
  params: Partial<Parameters<typeof postJson>[0]> = {},
  status = 200,
  phrase = "",
  received?: () => void,
) {
  let authorization: string | undefined;
  const result = await withServer(
    (request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(status, phrase);
      response.write(body);
      if (!received) {
        response.end(); // Cancellation is tested with the body still open.
      }
    },
    async (baseUrl) => {
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        const response = await realFetch(baseUrl, init);
        received?.();
        return response;
      });
      return postJson({ ...requestDefaults, ...params }, (response) => response.json()).catch(
        (cause: unknown) => cause,
      );
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
    expect(() =>
      readCredential({ source, provider: "default", id: "TEST_SEARCH_REFERENCE" }),
    ).toThrow(UnresolvedSecretInputError);
  });
});

it("reads a required query and keeps count fallback resolution with the caller", () => {
  expect(readQuery({ query: "  test  ", count: 2 }, { maxResults: 7 })).toEqual({
    query: "test",
    count: 2,
  });
  expect(readQuery({ query: "test" }, { maxResults: 7 })).toEqual({ query: "test", count: 7 });
  expect(readQuery({ query: "test" })).toEqual({ query: "test", count: undefined });
  expect(() => readQuery({})).toThrow("query required");
});

it.each([0, -1, 1.5, 11, "invalid"])("rejects invalid count %s", (count) => {
  expect(() => readQuery({ query: "test", count }, { maxResults: 7 })).toThrow(
    "count must be an integer from 1 to 10.",
  );
});

it.each([
  ["short body credential", "s7Key", "rejected $key", "", undefined, "rejected ***"],
  ["short reason credential", "s7Key", "", "rejected $key", undefined, "rejected ***"],
  ["bearer reflection", "synthetic-web-key-long", "Bearer $key", "", undefined, "***"],
  ["truncated credential", "synthetic-web-key-long", "rejected $key", "", 15, "rejected ***"],
  ["ordinary detail", "s7Key", "quota exceeded", "", undefined, "quota exceeded"],
] as const)(
  "redacts %s without discarding diagnostics",
  async (_, apiKey, body, phrase, maxErrorBytes, expected) => {
    const { result: error, authorization } = await requestSearch(
      body.replace("$key", apiKey),
      { apiKey, maxErrorBytes },
      401,
      phrase.replace("$key", apiKey),
    );
    expect(authorization).toBe(`Bearer ${apiKey}`);
    const message = `Search API error (401): ${expected}`;
    expect(error).toMatchObject({ message, status: 401, statusCode: 401 });
    const diagnostic = redactLogRecordForTransport({ error: String(error) });
    expect(diagnostic).toEqual({ error: `ProviderHttpError: ${message}` });
    expect(String(diagnostic.error)).not.toContain(apiKey);
  },
);

it("preserves caller cancellation after error headers arrive", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic caller cancellation");
  const { result } = await requestSearch(
    "partial diagnostic",
    { signal: controller.signal },
    401,
    "",
    () => controller.abort(reason),
  );
  expect(result).toBe(reason);
});

it("keeps successful responses and existing two-argument SDK calls usable", async () => {
  expect(redactToolPayloadText("Bearer tokens")).toBe("Bearer tokens");
  const { result } = await requestSearch('{"answer":"Bearer tokens"}');
  expect(result).toEqual({ answer: "Bearer tokens" });
  await expect(
    throwWebSearchApiError(new Response("quota exceeded", { status: 429 }), "Search"),
  ).rejects.toThrow("Search API error (429): quota exceeded");
});

it("honors the reader TTL while preserving the shipped one-argument reader", async () => {
  const { readCachedSearchPayload: read, writeCachedSearchPayload: write } =
    await import("./web-search-provider-common.js");
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const key = "query:reader-ttl";
  write(key, { text: "original" }, 900_000);
  expect(read(key, 0)).toBeUndefined();
  write(key, { text: "disabled" }, 0);
  clock.mockReturnValue(61_000);
  expect(read(key, 60_000)).toBeUndefined();
  expect(read(key)).toEqual({ text: "original", cached: true });
  clock.mockReturnValue(901_001);
  expect(read(key)).toBeUndefined();
});

it("keeps cache entries module-local instead of exposing them on a global symbol", async () => {
  vi.resetModules();
  const globals = globalThis as Record<PropertyKey, unknown>;
  const symbol = Symbol.for("openclaw.web-search.cache");
  delete globals[symbol];

  const module = await import("./web-search-provider-common.js");
  const cacheKey = "query:test";
  module.writeCachedSearchPayload(cacheKey, { ok: true }, 60_000);

  expect(module.readCachedSearchPayload(cacheKey)).toEqual({ ok: true, cached: true });
  expect(globals[symbol]).toBeUndefined();
});

import { afterEach, expect, it, vi } from "vitest";
import { fetchWithRuntimeDispatcher } from "./runtime-fetch.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
});

it("drops symbol header metadata before runtime fetch without mutating caller headers", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: vi.fn(),
    EnvHttpProxyAgent: vi.fn(),
    ProxyAgent: vi.fn(),
    fetch,
  };
  const headers = { "Content-Type": "application/json" };
  Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
    value: new Set(["content-type"]),
    enumerable: false,
  });
  const response = await fetchWithRuntimeDispatcher("https://example.com", {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(response.status).toBe(200);
  expect(fetch).toHaveBeenCalledOnce();
  const sentHeaders = fetch.mock.calls[0]?.[1]?.headers;
  expect(new Headers(sentHeaders).get("content-type")).toBe("application/json");
  expect(sentHeaders).not.toBe(headers);
  expect(Object.getOwnPropertySymbols(sentHeaders as object)).toStrictEqual([]);
  expect(Object.getOwnPropertySymbols(headers)).toHaveLength(1);
});

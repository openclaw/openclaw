// web_fetch app egress tests prove URL fetches are not filtered by retired web_fetch SSRF knobs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createWebFetchTool } from "./web-fetch.js";
import { makeFetchHeaders } from "./web-fetch.test-harness.js";
import "./web-fetch.test-mocks.js";

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeFetchHeaders({ "content-type": "text/plain" }),
    text: async () => body,
  } as unknown as Response;
}

function setMockFetch(
  impl: FetchMock = async (_input: RequestInfo | URL, _init?: RequestInit) => textResponse("ok"),
) {
  const fetchSpy = vi.fn(impl);
  global.fetch = withFetchPreconnect(fetchSpy);
  return fetchSpy;
}

function createWebFetchToolForTest() {
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
          },
        },
      },
    },
  });
}

function firstFetchUrl(fetchSpy: ReturnType<typeof setMockFetch>): string {
  const input = fetchSpy.mock.calls[0]?.[0];
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input;
}

function expectRawFetchSuccessDetails(details: unknown) {
  const typedDetails = details as { status?: number; extractor?: string };
  expect(typedDetails.status).toBe(200);
  expect(typedDetails.extractor).toBe("raw");
}

describe("web_fetch app egress", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it.each([
    "http://localhost/test",
    "http://127.0.0.1/test",
    "http://198.18.0.153/file",
    "http://[fc00::153]/file",
  ])("fetches %s through the app transport", async (url) => {
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = createWebFetchToolForTest();

    const result = await tool?.execute?.("call", { url });

    expectRawFetchSuccessDetails(result?.details);
    expect(firstFetchUrl(fetchSpy)).toBe(new URL(url).toString());
  });

  it("preserves URL argument sanitation before app transport dispatch", async () => {
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = createWebFetchToolForTest();

    await tool?.execute?.("call", { url: "\u00a0\ufeffhttps://example.com/a\u00a0" });

    expect(firstFetchUrl(fetchSpy)).toBe("https://example.com/a%C2%A0");
  });
});

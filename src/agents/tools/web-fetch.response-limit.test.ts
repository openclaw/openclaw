import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { createWebFetchTool } from "./web-tools.js";

// Avoid dynamic-importing heavy readability deps in this unit test suite.
vi.mock("./web-fetch-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("./web-fetch-utils.js")>("./web-fetch-utils.js");
  return {
    ...actual,
    extractReadableContent: vi.fn().mockResolvedValue({
      title: "HTML Page",
      text: "HTML Page\n\nContent here.",
    }),
  };
});

const lookupMock = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const baseToolConfig = {
  config: {
    tools: {
      web: { fetch: { cacheTtlMinutes: 0, firecrawl: { enabled: false }, maxResponseBytes: 1024 } },
    },
  },
} as const;

describe("web_fetch response size limits", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation((hostname) =>
      resolvePinnedHostname(hostname, lookupMock),
    );
  });

  afterEach(() => {
    // @ts-expect-error restore
    global.fetch = priorFetch;
    lookupMock.mockReset();
    vi.restoreAllMocks();
  });

  it("caps response bytes and does not hang on endless streams", async () => {
    const chunk = new TextEncoder().encode("<html><body><div>hi</div></body></html>");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    const fetchSpy = vi.fn().mockResolvedValue(response);
    // @ts-expect-error mock fetch
    global.fetch = fetchSpy;

    const tool = createWebFetchTool(baseToolConfig);
    const result = await tool?.execute?.("call", { url: "https://example.com/stream" });

    expect(result?.details?.warning).toContain("Response body truncated");
  });
});

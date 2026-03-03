import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithWebToolsNetworkGuardMock } = vi.hoisted(() => ({
  fetchWithWebToolsNetworkGuardMock: vi.fn(),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  fetchWithWebToolsNetworkGuard: fetchWithWebToolsNetworkGuardMock,
}));

import { createWebFetchTool } from "./web-tools.js";

describe("web_fetch env proxy retry", () => {
  beforeEach(() => {
    fetchWithWebToolsNetworkGuardMock.mockReset();
  });

  it("retries with useEnvProxy when strict fetch fails with TypeError('fetch failed')", async () => {
    const response = new Response("ok-body", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

    fetchWithWebToolsNetworkGuardMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        response,
        finalUrl: "https://example.com/",
        release: vi.fn().mockResolvedValue(undefined),
      });

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: {
              cacheTtlMinutes: 0,
              firecrawl: { enabled: false },
            },
          },
        },
      },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call", { url: "https://example.com" });
    const details = result?.details as { text?: string };

    expect(fetchWithWebToolsNetworkGuardMock).toHaveBeenCalledTimes(2);
    expect(fetchWithWebToolsNetworkGuardMock.mock.calls[0]?.[0]).not.toMatchObject({
      useEnvProxy: true,
    });
    expect(fetchWithWebToolsNetworkGuardMock.mock.calls[1]?.[0]).toMatchObject({
      url: "https://example.com",
      useEnvProxy: true,
    });
    expect(details.text).toContain("ok-body");
  });
});

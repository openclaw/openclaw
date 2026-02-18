import { describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import {
  createBaseWebFetchToolConfig,
  installWebFetchSsrfHarness,
} from "./web-fetch.test-harness.js";
import "./web-fetch.test-mocks.js";
import { createWebFetchTool } from "./web-tools.js";

const baseToolConfig = createBaseWebFetchToolConfig({ maxResponseBytes: 1024 });
installWebFetchSsrfHarness();

describe("web_fetch response size limits", () => {
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
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);
    const result = await tool?.execute?.("call", { url: "https://example.com/stream" });
    const details = result?.details as { warning?: string } | undefined;
    expect(details?.warning).toContain("Response body truncated");
  });
});

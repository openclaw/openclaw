import { describe, expect, it } from "vitest";
import { createSdkBoundedFetch } from "../../agents/sdk-bounded-fetch.js";

describe("openai-responses SSE stream bounding", () => {
  it("imports and invokes createSdkBoundedFetch without error", () => {
    const boundedFetch = createSdkBoundedFetch();
    expect(boundedFetch).toBeInstanceOf(Function);
  });

  it("caps oversized SSE responses when invoked through the bounded fetch wrapper", async () => {
    const cap = 1024;
    const chunk = new Uint8Array(768);
    let upstreamPulls = 0;
    let upstreamCancelled = false;

    const mockFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            upstreamPulls++;
            if (upstreamPulls > 5) {
              controller.close();
              return;
            }
            controller.enqueue(chunk);
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );

    const boundedFetch = createSdkBoundedFetch(mockFetch, { maxBytes: cap });
    const response = await boundedFetch("https://api.openai.com/responses");
    const reader = response.body!.getReader();

    let totalRead = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        totalRead += value.byteLength;
      }
    } catch {
      // Expected when cap is exceeded
    }

    // 2 chunks = 1536 > 1024 cap, so we should read at most 2 chunks
    expect(totalRead).toBeLessThanOrEqual(cap + chunk.byteLength);
    expect(totalRead).toBeLessThan(upstreamPulls * chunk.byteLength);
    expect(upstreamCancelled).toBe(true);
  });
});

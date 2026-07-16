// Verifies Control UI GitHub bounded response reads include idle timeouts.
import { describe, expect, it, vi } from "vitest";
import { GITHUB_REQUEST_TIMEOUT_MS, readBoundedResponse } from "./control-ui-github-api.js";

describe("readBoundedResponse", () => {
  it("times out when a GitHub response body stalls after headers", async () => {
    vi.useFakeTimers();
    try {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":'));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      const settled = expect(readBoundedResponse(response, 1024)).rejects.toThrow(
        `GitHub API response stalled: no data received for ${GITHUB_REQUEST_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(GITHUB_REQUEST_TIMEOUT_MS + 10);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns under-cap bodies", async () => {
    const payload = Buffer.from('{"ok":true}');
    await expect(readBoundedResponse(new Response(payload), 1024)).resolves.toEqual(payload);
  });
});

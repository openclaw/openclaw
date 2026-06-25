// Real behavior proof for PR #96347.
// Tests readResponseWithLimit directly AND exercises the production
// getLatestVersion() path through a mocked fetchWithSsrFGuard.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readResponseWithLimit } from "../../../packages/media-core/src/read-response-with-limit.js";

const MAX_BYTES = 1 * 1024 * 1024;
const onOverflow = ({ maxBytes }: { maxBytes: number }) =>
  new Error(`GitHub API release response exceeds ${maxBytes} bytes`);

describe("bounded read (helper level)", () => {
  it("accepts a normal-sized JSON response", async () => {
    const body = JSON.stringify({ tag_name: "v1.0.0" });
    const bytes = await readResponseWithLimit(new Response(body), MAX_BYTES, { onOverflow });
    const data = JSON.parse(new TextDecoder().decode(bytes)) as { tag_name: string };
    expect(data.tag_name).toBe("v1.0.0");
  });

  it("rejects an oversized response exceeding 1 MiB", async () => {
    const body = JSON.stringify({ _padding: "x".repeat(MAX_BYTES) });
    await expect(
      readResponseWithLimit(new Response(body), MAX_BYTES, { onOverflow }),
    ).rejects.toThrow(/exceeds/);
  });
});

// Production-path tests: mock fetchWithSsrFGuard so getLatestVersion()
// can be tested without hitting GitHub.  Vitest hoists the mock before
// any dynamic import of tools-manager.js.
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mockFetch,
}));

describe("getLatestVersion (production path)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("accepts a normal GitHub release response", async () => {
    mockFetch.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ tag_name: "v10.3.0" })),
      release: () => Promise.resolve(),
    });
    const { getLatestVersion } = await import("../../../src/agents/utils/tools-manager.js");
    await expect(getLatestVersion("test/repo")).resolves.toBe("10.3.0");
  });

  it("rejects an oversized GitHub release response", async () => {
    mockFetch.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          tag_name: "v99.0.0",
          _padding: "x".repeat(MAX_BYTES),
        }),
      ),
      release: () => Promise.resolve(),
    });
    const { getLatestVersion } = await import("../../../src/agents/utils/tools-manager.js");
    await expect(getLatestVersion("test/repo")).rejects.toThrow(/exceeds/);
  });
});

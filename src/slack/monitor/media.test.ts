import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";

// Store original fetch
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

describe("fetchWithSlackAuth", () => {
  beforeEach(() => {
    // Create a new mock for each test
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch;
    vi.resetModules();
  });

  it("sends Authorization header on initial request with manual redirect", async () => {
    // Import after mocking fetch
    const { fetchWithSlackAuth } = await import("./media.js");

    // Simulate direct 200 response (no redirect)
    const mockResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(result).toBe(mockResponse);

    // Verify fetch was called with correct params
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("https://files.slack.com/test.jpg", {
      headers: { Authorization: "Bearer xoxb-test-token" },
      redirect: "manual",
    });
  });

  it("rejects non-Slack hosts to avoid leaking tokens", async () => {
    const { fetchWithSlackAuth } = await import("./media.js");

    await expect(
      fetchWithSlackAuth("https://example.com/test.jpg", "xoxb-test-token"),
    ).rejects.toThrow(/non-Slack host|non-Slack/i);

    // Should fail fast without attempting a fetch.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("follows redirects without Authorization header", async () => {
    const { fetchWithSlackAuth } = await import("./media.js");

    // First call: redirect response from Slack
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: "https://cdn.slack-edge.com/presigned-url?sig=abc123" },
    });

    // Second call: actual file content from CDN
    const fileResponse = new Response(Buffer.from("actual image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fileResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(result).toBe(fileResponse);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call should have Authorization header and manual redirect
    expect(mockFetch).toHaveBeenNthCalledWith(1, "https://files.slack.com/test.jpg", {
      headers: { Authorization: "Bearer xoxb-test-token" },
      redirect: "manual",
    });

    // Second call should follow the redirect without Authorization
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://cdn.slack-edge.com/presigned-url?sig=abc123",
      { redirect: "follow" },
    );
  });

  it("handles relative redirect URLs", async () => {
    const { fetchWithSlackAuth } = await import("./media.js");

    // Redirect with relative URL
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: "/files/redirect-target" },
    });

    const fileResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fileResponse);

    await fetchWithSlackAuth("https://files.slack.com/original.jpg", "xoxb-test-token");

    // Second call should resolve the relative URL against the original
    expect(mockFetch).toHaveBeenNthCalledWith(2, "https://files.slack.com/files/redirect-target", {
      redirect: "follow",
    });
  });

  it("returns redirect response when no location header is provided", async () => {
    const { fetchWithSlackAuth } = await import("./media.js");

    // Redirect without location header
    const redirectResponse = new Response(null, {
      status: 302,
      // No location header
    });

    mockFetch.mockResolvedValueOnce(redirectResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    // Should return the redirect response directly
    expect(result).toBe(redirectResponse);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns 4xx/5xx responses directly without following", async () => {
    const { fetchWithSlackAuth } = await import("./media.js");

    const errorResponse = new Response("Not Found", {
      status: 404,
    });

    mockFetch.mockResolvedValueOnce(errorResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(result).toBe(errorResponse);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles 301 permanent redirects", async () => {
    const { fetchWithSlackAuth } = await import("./media.js");

    const redirectResponse = new Response(null, {
      status: 301,
      headers: { location: "https://cdn.slack.com/new-url" },
    });

    const fileResponse = new Response(Buffer.from("image data"), {
      status: 200,
    });

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fileResponse);

    await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(2, "https://cdn.slack.com/new-url", {
      redirect: "follow",
    });
  });
});

describe("resolveSlackMedia", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof fetch;
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      const addresses = ["93.184.216.34"];
      return {
        hostname: normalized,
        addresses,
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
      };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("prefers url_private_download over url_private", async () => {
    // Mock the store module
    vi.doMock("../../media/store.js", () => ({
      saveMediaBuffer: vi.fn().mockResolvedValue({
        path: "/tmp/test.jpg",
        contentType: "image/jpeg",
      }),
    }));

    const { resolveSlackMedia } = await import("./media.js");

    const mockResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    await resolveSlackMedia({
      files: [
        {
          url_private: "https://files.slack.com/private.jpg",
          url_private_download: "https://files.slack.com/download.jpg",
          name: "test.jpg",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://files.slack.com/download.jpg",
      expect.anything(),
    );
  });

  it("returns null when download fails", async () => {
    const { resolveSlackMedia } = await import("./media.js");

    // Simulate a network error
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await resolveSlackMedia({
      files: [{ url_private: "https://files.slack.com/test.jpg", name: "test.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
  });

  it("returns null when no files are provided", async () => {
    const { resolveSlackMedia } = await import("./media.js");

    const result = await resolveSlackMedia({
      files: [],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
  });

  it("skips files without url_private", async () => {
    const { resolveSlackMedia } = await import("./media.js");

    const result = await resolveSlackMedia({
      files: [{ name: "test.jpg" }], // No url_private
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls through to next file when first file returns error", async () => {
    // Mock the store module
    vi.doMock("../../media/store.js", () => ({
      saveMediaBuffer: vi.fn().mockResolvedValue({
        path: "/tmp/test.jpg",
        contentType: "image/jpeg",
      }),
    }));

    const { resolveSlackMedia } = await import("./media.js");

    // First file: 404
    const errorResponse = new Response("Not Found", { status: 404 });
    // Second file: success
    const successResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

    mockFetch.mockResolvedValueOnce(errorResponse).mockResolvedValueOnce(successResponse);

    const result = await resolveSlackMedia({
      files: [
        { url_private: "https://files.slack.com/first.jpg", name: "first.jpg" },
        { url_private: "https://files.slack.com/second.jpg", name: "second.jpg" },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("resolveSlackThreadHistory", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("paginates and returns the latest N messages across pages", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: Array.from({ length: 200 }, (_, i) => ({
          text: `msg-${i + 1}`,
          user: "U1",
          ts: `${i + 1}.000`,
        })),
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({
        messages: Array.from({ length: 60 }, (_, i) => ({
          text: `msg-${i + 201}`,
          user: "U1",
          ts: `${i + 201}.000`,
        })),
        response_metadata: { next_cursor: "" },
      });
    const { resolveSlackThreadHistory } = await import("./media.js");
    const client = {
      conversations: { replies },
    } as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      currentMessageTs: "260.000",
      limit: 5,
    });

    expect(replies).toHaveBeenCalledTimes(2);
    expect(replies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "C1",
        ts: "1.000",
        limit: 200,
        inclusive: true,
      }),
    );
    expect(replies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "C1",
        ts: "1.000",
        limit: 200,
        inclusive: true,
        cursor: "cursor-2",
      }),
    );
    expect(result.map((entry) => entry.ts)).toEqual([
      "255.000",
      "256.000",
      "257.000",
      "258.000",
      "259.000",
    ]);
  });

  it("includes file-only messages and drops empty-only entries", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [
        { text: "  ", ts: "1.000", files: [{ name: "screenshot.png" }] },
        { text: "   ", ts: "2.000" },
        { text: "hello", ts: "3.000", user: "U1" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const { resolveSlackThreadHistory } = await import("./media.js");
    const client = {
      conversations: { replies },
    } as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 10,
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe("[attached: screenshot.png]");
    expect(result[1]?.text).toBe("hello");
  });

  it("returns empty when limit is zero without calling Slack API", async () => {
    const replies = vi.fn();
    const { resolveSlackThreadHistory } = await import("./media.js");
    const client = {
      conversations: { replies },
    } as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 0,
    });

    expect(result).toEqual([]);
    expect(replies).not.toHaveBeenCalled();
  });

  it("returns empty when Slack API throws", async () => {
    const replies = vi.fn().mockRejectedValueOnce(new Error("slack down"));
    const { resolveSlackThreadHistory } = await import("./media.js");
    const client = {
      conversations: { replies },
    } as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 20,
    });

    expect(result).toEqual([]);
  });
});

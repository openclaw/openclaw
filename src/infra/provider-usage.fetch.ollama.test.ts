import { describe, expect, it, vi } from "vitest";
import { fetchOllamaUsage } from "./provider-usage.fetch.ollama.js";

describe("fetchOllamaUsage", () => {
  it("returns not logged in error when sign-in page is returned", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("<html><body>Sign in to continue</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await fetchOllamaUsage("session=test", 5000, mockFetch, "ollama");

    expect(result.provider).toBe("ollama");
    expect(result.displayName).toBe("Ollama");
    expect(result.error).toBe("Not logged in");
    expect(result.windows).toEqual([]);
  });

  it("parses usage from settings page", async () => {
    // Real HTML structure from ollama.com/settings
    const mockHtml = `
      <html>
        <body>
          <div>Session usage</div>
          <span>17.6% used</span>
          <div>Weekly usage</div>
          <span>10% used</span>
        </body>
      </html>
    `;

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(mockHtml, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await fetchOllamaUsage("session=test-cookie", 5000, mockFetch, "ollama");

    expect(result.provider).toBe("ollama");
    expect(result.displayName).toBe("Ollama");
    expect(result.error).toBeUndefined();
    expect(result.windows.length).toBeGreaterThan(0);
  });

  it("handles HTTP errors", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));

    const result = await fetchOllamaUsage("session=test", 5000, mockFetch, "ollama");

    expect(result.error).toContain("404");
  });

  it("sends cookie header correctly", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("<html><body>Usage: 10%</body></html>", { status: 200 }));

    await fetchOllamaUsage("__Secure-session=abc123", 5000, mockFetch, "ollama");

    // The fetchFn is called with (url, init) where init contains the headers
    expect(mockFetch).toHaveBeenCalledWith(
      "https://ollama.com/settings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: "__Secure-session=abc123",
        }),
      }),
    );
  });

  it("parses low percentage values correctly (not inflated)", async () => {
    // Test that 0.5% stays as 0.5, not inflated to 50
    // Bug fix: parsePercentage was incorrectly multiplying small values by 100
    const mockHtml = `
      <html>
        <body>
          <div>Session usage</div>
          <span>0.5% used</span>
          <div>Weekly usage</div>
          <span>1% used</span>
        </body>
      </html>
    `;

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(mockHtml, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await fetchOllamaUsage("session=test", 5000, mockFetch, "ollama");

    expect(result.windows.length).toBe(2);
    // Session should be 0.5%, not 50%
    expect(result.windows[0].usedPercent).toBe(0.5);
    // Weekly should be 1%, not 100%
    expect(result.windows[1].usedPercent).toBe(1);
  });
});

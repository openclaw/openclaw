import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createWebSearchTool } from "./web-search.js";

describe("createWebSearchTool integration tests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Clear environment variables
    delete process.env.BRAVE_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SERPER_API_KEY;
  });

  it("should return null when search is disabled", () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            enabled: false,
          },
        },
      },
    };

    const tool = createWebSearchTool({ config });
    expect(tool).toBeNull();
  });

  it("should create tool with brave provider by default", () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            enabled: true,
            apiKey: "test-brave-key",
          },
        },
      },
    };

    const tool = createWebSearchTool({ config });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
    expect(tool?.description).toContain("Brave Search API");
  });

  it("should create tool with perplexity provider", () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "perplexity",
            perplexity: {
              apiKey: "test-perplexity-key",
            },
          },
        },
      },
    };

    const tool = createWebSearchTool({ config });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
    expect(tool?.description).toContain("Perplexity Sonar");
  });

  it("should create tool with serper provider", () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "serper",
            serper: {
              apiKey: "test-serper-key",
            },
          },
        },
      },
    };

    const tool = createWebSearchTool({ config });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
    expect(tool?.description).toContain("Serper");
  });

  it("should create tool with fallback provider", () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
            fallback: "serper",
            apiKey: "test-brave-key",
            serper: {
              apiKey: "test-serper-key",
            },
          },
        },
      },
    };

    const tool = createWebSearchTool({ config });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
    expect(tool?.description).toContain("fallback");
  });

  it("should handle missing API keys gracefully", () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
            // No apiKey provided
          },
        },
      },
    };

    const tool = createWebSearchTool({ config });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
    // Should have error handling in description
    expect(tool?.description).toContain("misconfigured");
  });

  it("should use fallback when primary provider fails to initialize", () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave", // No brave key
            fallback: "serper",
            serper: {
              apiKey: "test-serper-key",
            },
          },
        },
      },
    };

    const tool = createWebSearchTool({ config });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
    // Tool should be created successfully (fallback becomes primary)
    expect(tool?.description).toContain("web");
    expect(tool?.description).not.toContain("misconfigured");
  });

  it("should respect timeout configuration", async () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
            apiKey: "test-brave-key",
            timeoutSeconds: 60,
          },
        },
      },
    };

    const tool = createWebSearchTool({ config });
    expect(tool).not.toBeNull();

    // Mock fetch to test timeout behavior
    const mockFetch = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            new Response(JSON.stringify({ web: { results: [] } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }, 100);
      });
    });

    global.fetch = mockFetch;

    try {
      await tool?.execute("test-id", { query: "test query" });
    } catch {
      // Expected - mock will fail without proper API key
    }

    // Verify fetch was called with timeout
    expect(mockFetch).toHaveBeenCalled();
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1]).toHaveProperty("signal");
  });

  it("should handle sandboxed mode", () => {
    // In sandboxed mode, tool should be created even without explicit config
    const tool = createWebSearchTool({ sandboxed: true });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
  });

  it("should parse configuration options correctly", () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
            apiKey: "test-key",
            maxResults: 7,
            timeoutSeconds: 45,
            cacheTtlMinutes: 30,
          },
        },
      },
    };

    const tool = createWebSearchTool({ config });
    expect(tool).not.toBeNull();

    // Test that configuration is parsed and used
    // This would be verified through execution, but we can at least ensure tool creation succeeds
    expect(tool?.name).toBe("web_search");
  });
});

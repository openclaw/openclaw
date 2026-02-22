import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "./web-tools.js";

async function executeSearch(config: unknown) {
  const tool = createWebSearchTool({ config: config as never, sandboxed: false });
  if (!tool) {
    return null;
  }
  return (tool as { execute: (id: string, args: unknown) => Promise<unknown> }).execute("test-id", {
    query: "test",
  });
}

describe("web_search missing API key error messages", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes config validation hint when search config is absent (e.g. config failed to load)", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    // Empty config = what loadConfig() returns when INVALID_CONFIG error occurs
    const result = (await executeSearch({})) as { details?: { error?: string; message?: string } };
    expect(result?.details?.error).toBe("missing_brave_api_key");
    expect(result?.details?.message).toContain("config file may have validation errors");
  });

  it("does not include config validation hint when search config exists but key is missing", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    // search config present but no apiKey = user simply hasn't set a key
    const result = (await executeSearch({
      tools: { web: { search: { enabled: true } } },
    })) as { details?: { error?: string; message?: string } };
    expect(result?.details?.error).toBe("missing_brave_api_key");
    expect(result?.details?.message).not.toContain("config file may have validation errors");
  });
});

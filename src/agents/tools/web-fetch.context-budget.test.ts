import { describe, expect, it } from "vitest";
import { createWebFetchTool } from "./web-fetch.js";

// Minimal smoke: ensure tool creation works with contextBudget config.

describe("web_fetch (contextBudget)", () => {
  it("creates tool with contextBudget enabled", () => {
    const config: any = {
      agents: { defaults: { contextBudget: { enabled: true, webFetchMaxChars: 1234 } } },
      tools: { web: { fetch: { enabled: true, maxChars: 9999, firecrawl: { enabled: false } } } },
    };
    const tool = createWebFetchTool({ config, sandboxed: false });
    expect(tool?.name).toBe("web_fetch");
  });
});

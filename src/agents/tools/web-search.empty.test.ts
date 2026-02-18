import { describe, it, expect, vi } from "vitest";
import { createWebSearchTool } from "./web-search.js";

// Mock deps
vi.mock("./common.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./common.js")>();
  return {
    ...mod,
    readStringParam: (
      params: Record<string, unknown>,
      key: string,
      opts?: { required?: boolean },
    ) => {
      const val = params[key];
      if (typeof val !== "string") {
        if (opts?.required) {
          throw new Error("Missing");
        }
        return undefined;
      }
      return val; // Simple mock, bypassing logic for simplicity
    },
  };
});

describe("web_search tool", () => {
  const tool = createWebSearchTool({
    sandboxed: true,
    config: {
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
            apiKey: "mock-key",
          },
        },
      },
    },
  })!;

  it("returns empty result for empty query string", async () => {
    const result = await tool.execute("call-1", { query: "" }, undefined, undefined);

    expect((result.content[0] as { type: "text"; text: string }).text).toContain('"count": 0');
    expect((result.content[0] as { type: "text"; text: string }).text).toContain('"results": []');
  });

  it("returns empty result for whitespace-only query", async () => {
    const result = await tool.execute("call-2", { query: "   " }, undefined, undefined);

    expect((result.content[0] as { type: "text"; text: string }).text).toContain('"count": 0');
  });
});

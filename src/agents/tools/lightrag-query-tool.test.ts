import { describe, expect, it, vi, beforeEach } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import { createLightRAGQueryTool } from "./lightrag-query-tool.js";

const mocks = vi.hoisted(() => ({
  createLightRAGClient: vi.fn(),
}));

vi.mock("../../memory/lightrag-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../memory/lightrag-client.js")>(
    "../../memory/lightrag-client.js",
  );
  return {
    ...actual,
    createLightRAGClient: mocks.createLightRAGClient,
  };
});

describe("lightrag_query tool", () => {
  beforeEach(() => {
    mocks.createLightRAGClient.mockClear();
  });

  it("returns null when config is missing", () => {
    const tool = createLightRAGQueryTool({});
    expect(tool).toBeNull();
  });

  it("returns null when memorySearch config is missing", () => {
    const config = {
      agents: {},
    } as OpenClawConfig;

    const tool = createLightRAGQueryTool({ config });
    expect(tool).toBeNull();
  });

  it("returns null when lightrag is not enabled", () => {
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            lightrag: {
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createLightRAGQueryTool({ config });
    expect(tool).toBeNull();
  });

  it("creates tool when lightrag is enabled", () => {
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            lightrag: {
              enabled: true,
              endpoint: "http://localhost:8001",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createLightRAGQueryTool({ config });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("lightrag_query");
    expect(tool?.label).toBe("LightRAG Query");
  });

  it("returns error when service is unavailable", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(false),
      query: vi.fn(),
    };
    mocks.createLightRAGClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            lightrag: {
              enabled: true,
              endpoint: "http://localhost:8001",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createLightRAGQueryTool({ config });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("1", { query: "test query" });
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text);

    expect(parsed.disabled).toBe(true);
    expect(parsed.error).toBe("LightRAG service unavailable");
    expect(parsed.answer).toBe("");
    expect(parsed.sources).toEqual([]);
  });

  it("executes query successfully", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(true),
      query: vi.fn().mockResolvedValue({
        answer: "Test answer",
        sources: ["source1.txt", "source2.txt"],
        entities: ["Entity1", "Entity2"],
        confidence: 0.95,
      }),
    };
    mocks.createLightRAGClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            lightrag: {
              enabled: true,
              endpoint: "http://localhost:8001",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createLightRAGQueryTool({ config });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("1", { query: "test query" });
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text);

    expect(parsed.answer).toBe("Test answer");
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.entities).toHaveLength(2);
    expect(parsed.confidence).toBe(0.95);
    expect(mockClient.query).toHaveBeenCalledWith({
      query: "test query",
      mode: undefined,
      topK: undefined,
      includeSources: undefined,
    });
  });

  it("handles query errors gracefully", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(true),
      query: vi.fn().mockRejectedValue(new Error("Query failed")),
    };
    mocks.createLightRAGClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            lightrag: {
              enabled: true,
              endpoint: "http://localhost:8001",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createLightRAGQueryTool({ config });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("1", { query: "test query" });
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text);

    expect(parsed.disabled).toBe(true);
    expect(parsed.error).toBe("Query failed");
    expect(parsed.answer).toBe("");
    expect(parsed.sources).toEqual([]);
  });

  it("passes optional parameters correctly", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(true),
      query: vi.fn().mockResolvedValue({
        answer: "Test answer",
        sources: [],
        entities: [],
        confidence: 0.8,
      }),
    };
    mocks.createLightRAGClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            lightrag: {
              enabled: true,
              endpoint: "http://localhost:8001",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createLightRAGQueryTool({ config });
    expect(tool).not.toBeNull();

    await tool!.execute("1", {
      query: "test query",
      mode: "hybrid",
      topK: 10,
      includeSources: true,
    });

    expect(mockClient.query).toHaveBeenCalledWith({
      query: "test query",
      mode: "hybrid",
      topK: 10,
      includeSources: true,
    });
  });

  it("validates mode parameter", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(true),
      query: vi.fn().mockResolvedValue({
        answer: "Test answer",
        sources: [],
      }),
    };
    mocks.createLightRAGClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            lightrag: {
              enabled: true,
              endpoint: "http://localhost:8001",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createLightRAGQueryTool({ config });
    expect(tool).not.toBeNull();

    await tool!.execute("1", {
      query: "test query",
      mode: "invalid-mode",
    });

    expect(mockClient.query).toHaveBeenCalledWith({
      query: "test query",
      mode: undefined,
      topK: undefined,
      includeSources: undefined,
    });
  });

  it("respects agent-specific overrides", () => {
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            lightrag: {
              enabled: false,
            },
          },
        },
        agents: {
          beta: {
            memorySearch: {
              lightrag: {
                enabled: true,
                endpoint: "http://localhost:9001",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createLightRAGQueryTool({
      config,
      agentSessionKey: "agent:beta:main",
    });

    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("lightrag_query");
  });
});

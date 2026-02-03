import { describe, expect, it, vi, beforeEach } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import { createGraphitiSearchTool } from "./graphiti-search-tool.js";

const mocks = vi.hoisted(() => ({
  createGraphitiClient: vi.fn(),
}));

vi.mock("../../memory/graphiti-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../memory/graphiti-client.js")>(
    "../../memory/graphiti-client.js",
  );
  return {
    ...actual,
    createGraphitiClient: mocks.createGraphitiClient,
  };
});

describe("graphiti_search tool", () => {
  beforeEach(() => {
    mocks.createGraphitiClient.mockClear();
  });

  it("returns null when config is missing", () => {
    const tool = createGraphitiSearchTool({});
    expect(tool).toBeNull();
  });

  it("returns null when memorySearch config is missing", () => {
    const config = {
      agents: {},
    } as OpenClawConfig;

    const tool = createGraphitiSearchTool({ config });
    expect(tool).toBeNull();
  });

  it("returns null when graphiti is not enabled", () => {
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            graphiti: {
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createGraphitiSearchTool({ config });
    expect(tool).toBeNull();
  });

  it("creates tool when graphiti is enabled", () => {
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            graphiti: {
              enabled: true,
              endpoint: "http://localhost:8000",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createGraphitiSearchTool({ config });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("graphiti_search");
    expect(tool?.label).toBe("Graphiti Search");
  });

  it("returns error when service is unavailable", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(false),
      search: vi.fn(),
    };
    mocks.createGraphitiClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            graphiti: {
              enabled: true,
              endpoint: "http://localhost:8000",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createGraphitiSearchTool({ config });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("1", { query: "test query" });
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text);

    expect(parsed.disabled).toBe(true);
    expect(parsed.error).toBe("Graphiti service unavailable");
    expect(parsed.entities).toEqual([]);
    expect(parsed.relationships).toEqual([]);
  });

  it("executes search successfully", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(true),
      search: vi.fn().mockResolvedValue({
        entities: [{ id: "1", type: "Person", name: "Alice" }],
        relationships: [{ from: "1", to: "2", type: "KNOWS" }],
        total: 2,
      }),
    };
    mocks.createGraphitiClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            graphiti: {
              enabled: true,
              endpoint: "http://localhost:8000",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createGraphitiSearchTool({ config });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("1", { query: "test query" });
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text);

    expect(parsed.entities).toHaveLength(1);
    expect(parsed.relationships).toHaveLength(1);
    expect(parsed.total).toBe(2);
    expect(mockClient.search).toHaveBeenCalledWith({
      query: "test query",
      entityTypes: undefined,
      timeRange: undefined,
      limit: undefined,
    });
  });

  it("handles search errors gracefully", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(true),
      search: vi.fn().mockRejectedValue(new Error("Network error")),
    };
    mocks.createGraphitiClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            graphiti: {
              enabled: true,
              endpoint: "http://localhost:8000",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createGraphitiSearchTool({ config });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("1", { query: "test query" });
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text);

    expect(parsed.disabled).toBe(true);
    expect(parsed.error).toBe("Network error");
    expect(parsed.entities).toEqual([]);
    expect(parsed.relationships).toEqual([]);
  });

  it("passes optional parameters correctly", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(true),
      search: vi.fn().mockResolvedValue({
        entities: [],
        relationships: [],
        total: 0,
      }),
    };
    mocks.createGraphitiClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            graphiti: {
              enabled: true,
              endpoint: "http://localhost:8000",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createGraphitiSearchTool({ config });
    expect(tool).not.toBeNull();

    await tool!.execute("1", {
      query: "test query",
      entityTypes: ["Person", "Project"],
      timeRange: { start: "2024-01-01", end: "2024-12-31" },
      limit: 20,
    });

    expect(mockClient.search).toHaveBeenCalledWith({
      query: "test query",
      entityTypes: ["Person", "Project"],
      timeRange: { start: "2024-01-01", end: "2024-12-31" },
      limit: 20,
    });
  });

  it("respects agent-specific overrides", () => {
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            graphiti: {
              enabled: false,
            },
          },
        },
        agents: {
          alpha: {
            memorySearch: {
              graphiti: {
                enabled: true,
                endpoint: "http://localhost:9000",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createGraphitiSearchTool({
      config,
      agentSessionKey: "agent:alpha:main",
    });

    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("graphiti_search");
  });
});

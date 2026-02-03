import { describe, expect, it, vi, beforeEach } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import { createMemoryServiceQueryTool } from "./memory-service-query-tool.js";

const mocks = vi.hoisted(() => ({
  createMemoryServiceClient: vi.fn(),
}));

vi.mock("../../memory/memory-service-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../memory/memory-service-client.js")>(
    "../../memory/memory-service-client.js",
  );
  return {
    ...actual,
    createMemoryServiceClient: mocks.createMemoryServiceClient,
  };
});

describe("memory_service_query tool", () => {
  beforeEach(() => {
    mocks.createMemoryServiceClient.mockClear();
  });

  it("returns null when config is missing", () => {
    const tool = createMemoryServiceQueryTool({});
    expect(tool).toBeNull();
  });

  it("returns null when memorySearch config is missing", () => {
    const config = {
      agents: {},
    } as OpenClawConfig;

    const tool = createMemoryServiceQueryTool({ config });
    expect(tool).toBeNull();
  });

  it("returns null when memoryService is not enabled", () => {
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            memoryService: {
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createMemoryServiceQueryTool({ config });
    expect(tool).toBeNull();
  });

  it("creates tool when memoryService is enabled", () => {
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            memoryService: {
              enabled: true,
              endpoint: "http://localhost:8002",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createMemoryServiceQueryTool({ config });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("memory_service_query");
    expect(tool?.label).toBe("Memory Service Query");
  });

  it("returns error when service is unavailable", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(false),
      search: vi.fn(),
    };
    mocks.createMemoryServiceClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            memoryService: {
              enabled: true,
              endpoint: "http://localhost:8002",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createMemoryServiceQueryTool({ config });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("1", { query: "test query" });
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text);

    expect(parsed.disabled).toBe(true);
    expect(parsed.error).toBe("Memory Service unavailable");
    expect(parsed.memories).toEqual([]);
  });

  it("executes search successfully", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(true),
      search: vi.fn().mockResolvedValue({
        memories: [
          { id: "1", content: "Memory 1", timestamp: "2024-01-01" },
          { id: "2", content: "Memory 2", timestamp: "2024-01-02" },
        ],
        total: 2,
      }),
    };
    mocks.createMemoryServiceClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            memoryService: {
              enabled: true,
              endpoint: "http://localhost:8002",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createMemoryServiceQueryTool({ config });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("1", { query: "test query" });
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text);

    expect(parsed.memories).toHaveLength(2);
    expect(parsed.total).toBe(2);
    expect(mockClient.search).toHaveBeenCalledWith({
      query: "test query",
      limit: undefined,
    });
  });

  it("handles search errors gracefully", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(true),
      search: vi.fn().mockRejectedValue(new Error("Database error")),
    };
    mocks.createMemoryServiceClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            memoryService: {
              enabled: true,
              endpoint: "http://localhost:8002",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createMemoryServiceQueryTool({ config });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("1", { query: "test query" });
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text);

    expect(parsed.disabled).toBe(true);
    expect(parsed.error).toBe("Database error");
    expect(parsed.memories).toEqual([]);
  });

  it("passes limit parameter correctly", async () => {
    const mockClient = {
      health: vi.fn().mockResolvedValue(true),
      search: vi.fn().mockResolvedValue({
        memories: [],
        total: 0,
      }),
    };
    mocks.createMemoryServiceClient.mockReturnValue(mockClient);

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            memoryService: {
              enabled: true,
              endpoint: "http://localhost:8002",
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createMemoryServiceQueryTool({ config });
    expect(tool).not.toBeNull();

    await tool!.execute("1", {
      query: "test query",
      limit: 50,
    });

    expect(mockClient.search).toHaveBeenCalledWith({
      query: "test query",
      limit: 50,
    });
  });

  it("respects agent-specific overrides", () => {
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            memoryService: {
              enabled: false,
            },
          },
        },
        agents: {
          gamma: {
            memorySearch: {
              memoryService: {
                enabled: true,
                endpoint: "http://localhost:9002",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createMemoryServiceQueryTool({
      config,
      agentSessionKey: "agent:gamma:main",
    });

    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("memory_service_query");
  });
});

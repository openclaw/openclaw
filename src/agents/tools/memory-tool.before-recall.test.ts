import { describe, expect, it, vi } from "vitest";
import { PluginHookExecutionError } from "../../plugins/hooks.js";

const search = vi.fn(async () => []);
const status = vi.fn(() => ({
  files: 0,
  chunks: 0,
  dirty: false,
  workspaceDir: "/tmp",
  dbPath: "/tmp/index.sqlite",
  provider: "openai",
  model: "text-embedding-3-small",
  requestedProvider: "openai",
}));

const runBeforeRecall = vi.fn();
const runAfterRecall = vi.fn();
const hasHooks = vi.fn(() => false);

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: async () => ({
    manager: {
      search,
      status,
    },
  }),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks,
    runBeforeRecall,
    runAfterRecall,
  }),
}));

import { createMemorySearchTool } from "./memory-tool.js";

describe("memory_search before_recall hook integration", () => {
  it("allows before_recall hooks to mutate query parameters", async () => {
    hasHooks.mockReturnValue(true);
    runBeforeRecall.mockResolvedValue({
      query: "rewritten query",
      maxResults: 2,
      minScore: 0.8,
    });

    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemorySearchTool({ config: cfg, agentSessionKey: "agent:main:dm" });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    await tool.execute("call_1", { query: "original query", maxResults: 6, minScore: 0.2 });

    expect(runBeforeRecall).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("rewritten query", {
      maxResults: 2,
      minScore: 0.8,
      sessionKey: "agent:main:dm",
    });
    expect(runAfterRecall).toHaveBeenCalledTimes(1);
  });

  it("propagates fail-closed before_recall errors", async () => {
    hasHooks.mockReturnValue(true);
    runBeforeRecall.mockRejectedValue(
      new PluginHookExecutionError({
        hookName: "before_recall",
        pluginId: "policy",
        message: "recall denied",
      }),
    );

    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemorySearchTool({ config: cfg, agentSessionKey: "agent:main:dm" });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    await expect(
      tool.execute("call_2", { query: "original query", maxResults: 6, minScore: 0.2 }),
    ).rejects.toThrow("recall denied");
  });
});

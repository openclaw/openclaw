import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { executeSystemAgentOperation } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

describe("system agent plugin reads", () => {
  it.each(["plugin-list", "plugin-search"] as const)(
    "bounds %s output across multiple catalog writes",
    async (kind) => {
      const { runtime, lines } = createSystemAgentTestRuntime();
      const writeLarge = async (target: RuntimeEnv) => {
        target.log("First result");
        target.log("x".repeat(6000));
        target.log("UNBOUNDED_TAIL");
      };
      await executeSystemAgentOperation(
        kind === "plugin-list" ? { kind } : { kind, query: "example" },
        runtime,
        {
          deps: {
            runPluginsList: writeLarge,
            runPluginsSearch: async (_query, target) => writeLarge(target),
          },
        },
      );
      const output = lines.join("\n");
      expect(output).toContain("First result");
      expect(output).toContain("output limit reached");
      expect(output).not.toContain("UNBOUNDED_TAIL");
      expect(output.length).toBeLessThanOrEqual(2100);
    },
  );

  it("runs plugin list and search as read-only operations", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runPluginsList = vi.fn(async (pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log("plugin rows");
    });
    const runPluginsSearch = vi.fn(async (query: string, pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log(`search rows: ${query}`);
    });

    const listResult = await executeSystemAgentOperation({ kind: "plugin-list" }, runtime, {
      deps: { runPluginsList, runPluginsSearch },
    });
    expect(listResult.applied).toBe(false);
    const searchResult = await executeSystemAgentOperation(
      { kind: "plugin-search", query: "calendar" },
      runtime,
      {
        deps: { runPluginsList, runPluginsSearch },
      },
    );
    expect(searchResult.applied).toBe(false);

    expect(runPluginsList).toHaveBeenCalledWith(
      expect.objectContaining({ log: expect.any(Function) }),
    );
    expect(runPluginsSearch).toHaveBeenCalledWith(
      "calendar",
      expect.objectContaining({ log: expect.any(Function) }),
    );
    expect(lines.join("\n")).toContain("plugin rows");
    expect(lines.join("\n")).toContain("search rows: calendar");
  });
});

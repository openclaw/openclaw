import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPluginsListCommand } from "../cli/plugins-list-command.js";
import { runPluginsSearchCommand } from "../cli/plugins-search-command.js";
import type { RuntimeEnv } from "../runtime.js";
import { executeSystemAgentOperation } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

// mock-isolation: Fixture catalog output proves bounded logging without installed-plugin discovery.
vi.mock("../cli/plugins-list-command.js", () => ({ runPluginsListCommand: vi.fn() }));
// mock-isolation: Fixture search output avoids contacting a real plugin registry.
vi.mock("../cli/plugins-search-command.js", () => ({ runPluginsSearchCommand: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe("system agent plugin reads", () => {
  it.each(["plugin-list", "plugin-search"] as const)(
    "runs %s read-only with bounded output across multiple catalog writes",
    async (kind) => {
      const { runtime, lines } = createSystemAgentTestRuntime();
      const writeLarge = async (target: RuntimeEnv) => {
        target.log("First result");
        target.log("x".repeat(6000));
        target.log("UNBOUNDED_TAIL");
      };
      vi.mocked(runPluginsListCommand).mockImplementation(async (_opts, target) => {
        await writeLarge(target!);
      });
      vi.mocked(runPluginsSearchCommand).mockImplementation(async (query, _opts, target) => {
        expect(query).toBe("example");
        await writeLarge(target!);
      });
      const result = await executeSystemAgentOperation(
        kind === "plugin-list" ? { kind } : { kind, query: "example" },
        runtime,
      );
      expect(result.applied).toBe(false);
      const output = lines.join("\n");
      expect(output).toContain("First result");
      expect(output).toContain("output limit reached");
      expect(output).not.toContain("UNBOUNDED_TAIL");
      expect(output.length).toBeLessThanOrEqual(2100);
    },
  );
});

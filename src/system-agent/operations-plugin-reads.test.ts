import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { executeSystemAgentOperation } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

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
      const result = await executeSystemAgentOperation(
        kind === "plugin-list" ? { kind } : { kind, query: "example" },
        runtime,
        {
          deps: {
            runPluginsList: writeLarge,
            runPluginsSearch: async (query, target) => {
              expect(query).toBe("example");
              await writeLarge(target);
            },
          },
        },
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

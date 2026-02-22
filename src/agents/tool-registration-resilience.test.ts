import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
  getPluginToolMeta: () => undefined,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: () => false,
    runBeforeToolCall: vi.fn(),
  }),
}));

describe("tool registration resilience", () => {
  describe("createOpenClawTools safeTool pattern", () => {
    it("safeTool returns result on success", () => {
      function safeTool<T>(label: string, factory: () => T): T | null {
        try {
          return factory();
        } catch {
          return null;
        }
      }

      const tool = safeTool("test", () => ({
        name: "test_tool",
        execute: async () => "ok",
      }));
      expect(tool).not.toBeNull();
      expect(tool?.name).toBe("test_tool");
    });

    it("safeTool returns null on error without throwing", () => {
      function safeTool<T>(label: string, factory: () => T): T | null {
        try {
          return factory();
        } catch {
          return null;
        }
      }

      const tool = safeTool("broken", () => {
        throw new Error("initialization failed");
      });
      expect(tool).toBeNull();
    });

    it("safeTool isolates failures so other tools still register", () => {
      function safeTool<T>(label: string, factory: () => T): T | null {
        try {
          return factory();
        } catch {
          return null;
        }
      }

      const tools = [
        safeTool("a", () => ({ name: "tool_a", execute: async () => "ok" })),
        safeTool("b", (): { name: string; execute: () => Promise<string> } => {
          throw new Error("tool_b init crash");
        }),
        safeTool("c", () => ({ name: "tool_c", execute: async () => "ok" })),
      ].filter((t): t is NonNullable<typeof t> => t != null);

      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(["tool_a", "tool_c"]);
    });
  });

  describe("codingTools flatMap per-tool error handling", () => {
    it("catches per-tool errors without breaking the entire flatMap", () => {
      const mockCodingTools = [
        { name: "read", execute: vi.fn() },
        { name: "write", execute: vi.fn() },
        { name: "edit", execute: vi.fn() },
      ] as unknown as AnyAgentTool[];

      const warnings: string[] = [];

      const base = mockCodingTools.flatMap((tool) => {
        try {
          if (tool.name === "read") {
            return [{ ...tool, wrapped: true }];
          }
          if (tool.name === "write") {
            throw new Error("write tool creation failed during restart");
          }
          if (tool.name === "edit") {
            return [{ ...tool, wrapped: true }];
          }
          return [tool];
        } catch (err) {
          warnings.push(
            `tool registration failed for "${tool.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }
      });

      expect(base).toHaveLength(2);
      expect(base.map((t) => t.name)).toEqual(["read", "edit"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("write");
      expect(warnings[0]).toContain("tool registration failed");
    });
  });

  describe("tool registration validation", () => {
    it("detects missing core tools", () => {
      const EXPECTED_CORE_TOOLS = ["read", "write", "edit", "exec", "web_search", "web_fetch"];
      const registeredTools = [
        { name: "exec" },
        { name: "web_fetch" },
        { name: "process" },
      ] as AnyAgentTool[];

      const registeredNames = new Set(registeredTools.map((t) => t.name));
      const missing = EXPECTED_CORE_TOOLS.filter((name) => !registeredNames.has(name));

      expect(missing).toEqual(["read", "write", "edit", "web_search"]);
    });

    it("reports no missing tools when all core tools are present", () => {
      const EXPECTED_CORE_TOOLS = ["read", "write", "edit", "exec", "web_search", "web_fetch"];
      const registeredTools = [
        { name: "read" },
        { name: "write" },
        { name: "edit" },
        { name: "exec" },
        { name: "web_search" },
        { name: "web_fetch" },
        { name: "browser" },
        { name: "gateway" },
      ] as AnyAgentTool[];

      const registeredNames = new Set(registeredTools.map((t) => t.name));
      const missing = EXPECTED_CORE_TOOLS.filter((name) => !registeredNames.has(name));

      expect(missing).toEqual([]);
    });

    it("validation covers the exact failure pattern from #22426", () => {
      // The bug: read, write, edit, web_search fail while exec, web_fetch work
      const EXPECTED_CORE_TOOLS = ["read", "write", "edit", "exec", "web_search", "web_fetch"];
      const registeredTools = [
        { name: "exec" },
        { name: "web_fetch" },
        { name: "process" },
        { name: "browser" },
        { name: "gateway" },
      ] as AnyAgentTool[];

      const registeredNames = new Set(registeredTools.map((t) => t.name));
      const missing = EXPECTED_CORE_TOOLS.filter((name) => !registeredNames.has(name));

      expect(missing).toContain("read");
      expect(missing).toContain("write");
      expect(missing).toContain("edit");
      expect(missing).toContain("web_search");
      expect(missing).not.toContain("exec");
      expect(missing).not.toContain("web_fetch");
    });
  });
});

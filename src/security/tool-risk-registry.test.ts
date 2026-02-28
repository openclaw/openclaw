import { afterEach, describe, expect, it } from "vitest";
import {
  getToolMetadata,
  getToolRiskLevel,
  registerToolMetadata,
  resetToolRiskRegistry,
} from "./tool-risk-registry.js";

describe("tool-risk-registry", () => {
  afterEach(() => {
    resetToolRiskRegistry();
  });

  describe("getToolRiskLevel", () => {
    it("returns correct defaults for known tools", () => {
      expect(getToolRiskLevel("exec")).toBe("critical");
      expect(getToolRiskLevel("gateway")).toBe("critical");
      expect(getToolRiskLevel("sessions_spawn")).toBe("critical");
      expect(getToolRiskLevel("fs_write")).toBe("high");
      expect(getToolRiskLevel("fs_delete")).toBe("high");
      expect(getToolRiskLevel("edit")).toBe("high");
      expect(getToolRiskLevel("browser_navigate")).toBe("medium");
      expect(getToolRiskLevel("web_fetch")).toBe("medium");
      expect(getToolRiskLevel("fs_read")).toBe("low");
      expect(getToolRiskLevel("read")).toBe("low");
      expect(getToolRiskLevel("list")).toBe("low");
    });

    it("returns undefined for unknown tools", () => {
      expect(getToolRiskLevel("custom_tool")).toBeUndefined();
    });
  });

  describe("getToolMetadata", () => {
    it("returns default metadata for known tools", () => {
      const meta = getToolMetadata("exec");
      expect(meta).toBeDefined();
      expect(meta!.name).toBe("exec");
      expect(meta!.riskLevel).toBe("critical");
      expect(meta!.humanReadableSummary({ command: "ls -la" })).toBe("Execute command: ls -la");
    });

    it("returns undefined for unknown tools", () => {
      expect(getToolMetadata("unknown_tool")).toBeUndefined();
    });

    it("generates summary for tools without explicit templates", () => {
      const meta = getToolMetadata("memory_search");
      expect(meta).toBeDefined();
      expect(meta!.humanReadableSummary({ query: "test" })).toBe("memory_search(query)");
    });
  });

  describe("registerToolMetadata", () => {
    it("allows registering custom tool metadata", () => {
      registerToolMetadata({
        name: "custom_tool",
        description: "A custom tool",
        riskLevel: "high",
        humanReadableSummary: (args) =>
          `Custom: ${String((args as Record<string, unknown>).action)}`,
      });

      const meta = getToolMetadata("custom_tool");
      expect(meta).toBeDefined();
      expect(meta!.riskLevel).toBe("high");
      expect(meta!.humanReadableSummary({ action: "test" })).toBe("Custom: test");
    });

    it("overrides defaults when registering known tool", () => {
      registerToolMetadata({
        name: "exec",
        description: "Sandboxed exec",
        riskLevel: "medium",
        humanReadableSummary: () => "sandboxed",
      });

      expect(getToolRiskLevel("exec")).toBe("medium");
      expect(getToolMetadata("exec")!.humanReadableSummary({})).toBe("sandboxed");
    });
  });

  describe("default summary templates", () => {
    it("exec handles missing command", () => {
      const meta = getToolMetadata("exec")!;
      expect(meta.humanReadableSummary({})).toBe("Execute command: unknown");
    });

    it("fs_write uses path or file arg", () => {
      const meta = getToolMetadata("fs_write")!;
      expect(meta.humanReadableSummary({ path: "/tmp/x" })).toBe("Write file: /tmp/x");
      expect(meta.humanReadableSummary({ file: "/tmp/y" })).toBe("Write file: /tmp/y");
    });

    it("web_fetch uses url arg", () => {
      const meta = getToolMetadata("web_fetch")!;
      expect(meta.humanReadableSummary({ url: "https://evil.com" })).toBe(
        "Fetch URL: https://evil.com",
      );
    });
  });
});

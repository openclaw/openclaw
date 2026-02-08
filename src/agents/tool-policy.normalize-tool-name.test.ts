import { describe, expect, it } from "vitest";
import { normalizeToolName } from "./tool-policy.js";

describe("normalizeToolName", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeToolName(" exec")).toBe("exec");
    expect(normalizeToolName("exec ")).toBe("exec");
    expect(normalizeToolName("  exec  ")).toBe("exec");
    expect(normalizeToolName("\texec\n")).toBe("exec");
  });

  it("lowercases tool names", () => {
    expect(normalizeToolName("Exec")).toBe("exec");
    expect(normalizeToolName("BROWSER")).toBe("browser");
    expect(normalizeToolName(" Read ")).toBe("read");
  });

  it("resolves known aliases", () => {
    expect(normalizeToolName("bash")).toBe("exec");
    expect(normalizeToolName("BASH")).toBe("exec");
    expect(normalizeToolName(" bash ")).toBe("exec");
    expect(normalizeToolName("apply-patch")).toBe("apply_patch");
    expect(normalizeToolName(" Apply-Patch ")).toBe("apply_patch");
  });

  it("preserves valid tool names", () => {
    expect(normalizeToolName("exec")).toBe("exec");
    expect(normalizeToolName("read")).toBe("read");
    expect(normalizeToolName("web_search")).toBe("web_search");
    expect(normalizeToolName("memory_get")).toBe("memory_get");
  });

  it("handles empty and whitespace-only input", () => {
    expect(normalizeToolName("")).toBe("");
    expect(normalizeToolName("   ")).toBe("");
  });
});

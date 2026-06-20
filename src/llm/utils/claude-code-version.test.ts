import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:module", () => {
  const createRequire = vi.fn();
  return { createRequire };
});

import { resolveClaudeCodeVersion, _resetClaudeCodeVersionCache } from "./claude-code-version.js";

describe("resolveClaudeCodeVersion", () => {
  afterEach(() => {
    _resetClaudeCodeVersionCache();
  });

  it("returns the version from @anthropic-ai/claude-code/package.json", async () => {
    const { createRequire } = await import("node:module");
    const mockRequire = vi.fn().mockReturnValue({ version: "2.1.177" });
    (createRequire as ReturnType<typeof vi.fn>).mockReturnValue(mockRequire);

    expect(resolveClaudeCodeVersion("file:///test/url")).toBe("2.1.177");
  });

  it("caches the resolved version", async () => {
    const { createRequire } = await import("node:module");
    const mockRequire = vi.fn().mockReturnValue({ version: "2.1.177" });
    (createRequire as ReturnType<typeof vi.fn>).mockReturnValue(mockRequire);

    expect(resolveClaudeCodeVersion("file:///test/url")).toBe("2.1.177");
    // mockRequire should only be called once due to caching
    expect(mockRequire).toHaveBeenCalledTimes(1);
    // Second call returns cached value without calling require again
    expect(resolveClaudeCodeVersion("file:///test/url")).toBe("2.1.177");
    expect(mockRequire).toHaveBeenCalledTimes(1);
  });

  it("throws when the package is not installed", async () => {
    const { createRequire } = await import("node:module");
    const mockRequire = vi.fn().mockImplementation(() => {
      throw new Error("Cannot find module @anthropic-ai/claude-code/package.json");
    });
    (createRequire as ReturnType<typeof vi.fn>).mockReturnValue(mockRequire);

    expect(() => resolveClaudeCodeVersion("file:///test/url")).toThrow(
      /Cannot find module/,
    );
  });

  it("throws when version field is missing", async () => {
    const { createRequire } = await import("node:module");
    const mockRequire = vi.fn().mockReturnValue({});
    (createRequire as ReturnType<typeof vi.fn>).mockReturnValue(mockRequire);

    expect(() => resolveClaudeCodeVersion("file:///test/url")).toThrow(
      /no valid "version" field/,
    );
  });

  it("throws when version is an empty string", async () => {
    const { createRequire } = await import("node:module");
    const mockRequire = vi.fn().mockReturnValue({ version: "" });
    (createRequire as ReturnType<typeof vi.fn>).mockReturnValue(mockRequire);

    expect(() => resolveClaudeCodeVersion("file:///test/url")).toThrow(
      /no valid "version" field/,
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  normalizeWorkspaceDir,
  resolveWorkspaceRoot,
} from "./workspace-dir.js";

vi.mock("../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p.replace("~", "/home/user")),
}));

describe("normalizeWorkspaceDir", () => {
  it("returns null for empty/undefined input", () => {
    expect(normalizeWorkspaceDir(undefined)).toBeNull();
    expect(normalizeWorkspaceDir("")).toBeNull();
    expect(normalizeWorkspaceDir("   ")).toBeNull();
  });

  it("expands tilde to home directory", () => {
    const result = normalizeWorkspaceDir("~/projects");
    expect(result).toContain("/home/user");
    expect(result).toContain("projects");
  });

  it("returns null for filesystem root", () => {
    // Root path should be rejected as too broad
    const result = normalizeWorkspaceDir("/");
    expect(result).toBeNull();
  });

  it("resolves relative paths", () => {
    const result = normalizeWorkspaceDir("./my-project");
    expect(result).toBeDefined();
    expect(result).not.toContain("./");
  });

  it("trims whitespace", () => {
    const result = normalizeWorkspaceDir("  /tmp/project  ");
    expect(result).toContain("project");
  });
});

describe("resolveWorkspaceRoot", () => {
  it("returns normalized path when provided", () => {
    const result = resolveWorkspaceRoot("/custom/workspace");
    expect(result).toBeDefined();
    expect(result).not.toBe(process.cwd());
  });

  it("falls back to cwd when undefined", () => {
    const result = resolveWorkspaceRoot(undefined);
    expect(result).toBe(process.cwd());
  });
});

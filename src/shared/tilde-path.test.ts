import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
}));

import { expandTildePath } from "./tilde-path.js";

describe("expandTildePath", () => {
  it('expands bare "~" to the home directory', () => {
    expect(expandTildePath("~")).toBe("/home/testuser");
  });

  it('expands "~/path" to "<home>/path"', () => {
    expect(expandTildePath("~/documents")).toBe("/home/testuser/documents");
  });

  it('expands "~name" to "<home>/name"', () => {
    expect(expandTildePath("~otheruser")).toBe("/home/testuser/otheruser");
  });

  it("returns non-tilde paths unchanged", () => {
    expect(expandTildePath("/absolute/path")).toBe("/absolute/path");
    expect(expandTildePath("relative/path")).toBe("relative/path");
  });

  it("handles leading/trailing whitespace", () => {
    expect(expandTildePath("  ~/foo  ")).toBe("/home/testuser/foo");
  });

  it("returns trimmed non-tilde path with whitespace", () => {
    expect(expandTildePath("  /foo  ")).toBe("/foo");
  });

  it("returns empty string for empty input", () => {
    expect(expandTildePath("")).toBe("");
  });

  it("handles whitespace-only input", () => {
    expect(expandTildePath("   ")).toBe("");
  });
});

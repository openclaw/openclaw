import { describe, expect, it } from "vitest";
import { findDuplicateAgentDirs, formatDuplicateAgentDirError } from "./agent-dirs.js";

describe("findDuplicateAgentDirs", () => {
  it("returns empty array when no duplicates", () => {
    const dirs = ["/path/a", "/path/b", "/path/c"];
    expect(findDuplicateAgentDirs(dirs)).toEqual([]);
  });

  it("finds duplicate directories", () => {
    const dirs = ["/path/a", "/path/b", "/path/a"];
    const duplicates = findDuplicateAgentDirs(dirs);
    expect(duplicates).toContain("/path/a");
  });
});

describe("formatDuplicateAgentDirError", () => {
  it("formats error message correctly", () => {
    const error = formatDuplicateAgentDirError(["/path/a"]);
    expect(error).toContain("/path/a");
    expect(error).toContain("duplicate");
  });
});

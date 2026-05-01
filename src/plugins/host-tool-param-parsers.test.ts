import { describe, expect, it } from "vitest";
import { deriveToolParams } from "./host-tool-param-parsers.js";

describe("deriveToolParams", () => {
  it("returns an empty object for tools that have no registered parser", () => {
    expect(deriveToolParams("exec", { command: "ls" })).toEqual({});
    expect(deriveToolParams("read_file", { path: "/tmp/x" })).toEqual({});
  });

  it("derives apply_patch destination paths from the input envelope", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "@@",
      "+y",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    expect(deriveToolParams("apply_patch", { input: patch })).toEqual({
      derivedPaths: ["src/new.ts", "src/old.ts", "src/renamed.ts", "src/dead.ts"],
    });
  });

  it("returns an empty object when apply_patch input has no recognised paths", () => {
    expect(deriveToolParams("apply_patch", { input: "not a patch" })).toEqual({});
    expect(deriveToolParams("apply_patch", {})).toEqual({});
    expect(deriveToolParams("apply_patch", undefined)).toEqual({});
  });

  it("does not throw for malformed param shapes", () => {
    expect(deriveToolParams("apply_patch", null)).toEqual({});
    expect(deriveToolParams("apply_patch", 42)).toEqual({});
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveToolParams } from "./host-tool-param-parsers.js";

const defaultCwd = process.cwd();
const cwdPath = (...segments: string[]) => path.join(defaultCwd, ...segments);

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
      derivedPaths: [
        cwdPath("src/new.ts"),
        cwdPath("src/old.ts"),
        cwdPath("src/renamed.ts"),
        cwdPath("src/dead.ts"),
      ],
    });
  });

  it("returns immutable derived path snapshots", () => {
    const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+x", "*** End Patch"].join("\n");
    const derived = deriveToolParams("apply_patch", { input: patch });
    expect(Array.isArray(derived.derivedPaths)).toBe(true);
    expect(Object.isFrozen(derived.derivedPaths)).toBe(true);
  });

  it("resolves derived apply_patch paths against the tool cwd when provided", () => {
    const patch = ["*** Begin Patch", "*** Add File: @src/../new.ts", "+x", "*** End Patch"].join(
      "\n",
    );
    const cwd = path.join("/tmp", "openclaw-derived");
    expect(deriveToolParams("apply_patch", { input: patch }, { cwd })).toEqual({
      derivedPaths: [path.join(cwd, "new.ts")],
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

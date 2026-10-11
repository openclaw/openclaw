/** Tests host tool parameter parsers exposed to plugin callbacks. */
import { describe, expect, it } from "vitest";
import { deriveToolParams } from "./host-tool-param-parsers.js";

describe("deriveToolParams", () => {
  it("returns an empty object for tools that have no registered parser", async () => {
    await expect(deriveToolParams("exec", { command: "ls" })).resolves.toEqual({});
    await expect(deriveToolParams("read_file", { path: "/tmp/x" })).resolves.toEqual({});
  });

  it("returns immutable derived path snapshots", async () => {
    const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+x", "*** End Patch"].join("\n");
    const derived = await deriveToolParams("apply_patch", { input: patch });
    expect(Array.isArray(derived.derivedPaths)).toBe(true);
    expect(Object.isFrozen(derived.derivedPaths)).toBe(true);
  });

  it("returns an empty object when apply_patch input has no recognised paths", async () => {
    await expect(deriveToolParams("apply_patch", { input: "not a patch" })).resolves.toEqual({});
    await expect(deriveToolParams("apply_patch", {})).resolves.toEqual({});
    await expect(deriveToolParams("apply_patch", undefined)).resolves.toEqual({});
  });
});

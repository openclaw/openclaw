import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWithinDir, resolveSafeBaseDir } from "./path-safety.js";

describe("path-safety", () => {
  it("resolves safe base dir with trailing separator", () => {
    const base = resolveSafeBaseDir("/tmp/demo");
    expect(base.endsWith(path.sep)).toBe(true);
  });

  it("checks directory containment", () => {
    expect(isWithinDir("/tmp/demo", "/tmp/demo")).toBe(true);
    expect(isWithinDir("/tmp/demo", "/tmp/demo/sub/file.txt")).toBe(true);
    expect(isWithinDir("/tmp/demo", "/tmp/demo/../escape.txt")).toBe(false);
  });
});

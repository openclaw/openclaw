import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergePathPrepend, normalizePathPrepend } from "./path-prepend.js";

describe("path prepend helpers", () => {
  it("normalizes prepend lists by trimming, skipping blanks, and deduping", () => {
    expect(
      normalizePathPrepend([
        " /custom/bin ",
        "",
        " /custom/bin ",
        "/opt/bin",
        // oxlint-disable-next-line typescript/no-explicit-any
        42 as any,
      ]),
    ).toEqual(["/custom/bin", "/opt/bin"]);
    expect(normalizePathPrepend()).toEqual([]);
  });

  it("merges prepended paths ahead of existing values without duplicates", () => {
    expect(mergePathPrepend(`/usr/bin${path.delimiter}/opt/bin`, ["/custom/bin", "/usr/bin"])).toBe(
      ["/custom/bin", "/usr/bin", "/opt/bin"].join(path.delimiter),
    );
    expect(mergePathPrepend(undefined, ["/custom/bin"])).toBe("/custom/bin");
    expect(mergePathPrepend("/usr/bin", [])).toBe("/usr/bin");
  });

  it("trims existing path entries while preserving order", () => {
    expect(
      mergePathPrepend(` /usr/bin ${path.delimiter} ${path.delimiter} /opt/bin `, ["/custom/bin"]),
    ).toBe(["/custom/bin", "/usr/bin", "/opt/bin"].join(path.delimiter));
  });
});

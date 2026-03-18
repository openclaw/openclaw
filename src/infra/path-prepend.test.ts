import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPathPrepend,
  findPathKey,
  mergePathPrepend,
  normalizePathPrepend,
} from "./path-prepend.js";

describe("path prepend helpers", () => {
  it("finds the actual PATH key while preserving original casing", () => {
    expect(findPathKey({ PATH: "/usr/bin" })).toBe("PATH");
    expect(findPathKey({ Path: "/usr/bin" })).toBe("Path");
    expect(findPathKey({ path: "/usr/bin" })).toBe("path");
    expect(findPathKey({ PaTh: "/usr/bin" })).toBe("PaTh");
    expect(findPathKey({ HOME: "/tmp" })).toBe("PATH");
  });

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

  it("applies prepends to the discovered PATH key and preserves existing casing", () => {
    const env = {
      Path: [`/usr/bin`, `/opt/bin`].join(path.delimiter),
    };

    applyPathPrepend(env, ["/custom/bin", "/usr/bin"]);

    expect(env).toEqual({
      Path: ["/custom/bin", "/usr/bin", "/opt/bin"].join(path.delimiter),
    });
  });

  it("respects requireExisting and ignores empty prepend lists", () => {
    const envWithoutPath = { HOME: "/tmp/home" };
    applyPathPrepend(envWithoutPath, ["/custom/bin"], { requireExisting: true });
    expect(envWithoutPath).toEqual({ HOME: "/tmp/home" });

    const envWithBlankPath = { path: "" };
    applyPathPrepend(envWithBlankPath, ["/custom/bin"], { requireExisting: true });
    expect(envWithBlankPath).toEqual({ path: "" });

    const envWithPath = { PATH: "/usr/bin" };
    applyPathPrepend(envWithPath, [], { requireExisting: true });
    applyPathPrepend(envWithPath, undefined, { requireExisting: true });
    expect(envWithPath).toEqual({ PATH: "/usr/bin" });
  });

  it("creates PATH when prepends are provided and no path key exists", () => {
    const env = { HOME: "/tmp/home" };

    applyPathPrepend(env, ["/custom/bin"]);

    expect(env).toEqual({
      HOME: "/tmp/home",
      PATH: "/custom/bin",
    });
  });
});

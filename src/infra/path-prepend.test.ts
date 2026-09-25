// Verifies PATH prepend normalization, merge, and removal helpers.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPathPrepend,
  findPathKey,
  mergePathPrepend,
  normalizePathPrepend,
  removePathPrepend,
} from "./path-prepend.js";

const env = (value: Record<string, string>) => value;
const pathLine = (...parts: string[]) => parts.join(path.delimiter);

describe("path prepend helpers", () => {
  it.each([
    [env({ PATH: "/usr/bin" }), "PATH"],
    [env({ Path: "/usr/bin" }), "Path"],
    [env({ path: "/usr/bin" }), "path"],
    [env({ PaTh: "/usr/bin" }), "PaTh"],
    [env({ HOME: "/tmp" }), "PATH"],
  ])("finds the PATH key for %j", (envEntry, expected) => {
    expect(findPathKey(envEntry)).toBe(expected);
  });

  it("normalizes prepend lists by trimming, skipping blanks, and deduping", () => {
    expect(
      normalizePathPrepend([
        " /custom/bin ",
        "",
        " /custom/bin ",
        "/opt/bin",
        42 as unknown as string,
      ]),
    ).toEqual(["/custom/bin", "/opt/bin"]);
    expect(normalizePathPrepend()).toStrictEqual([]);
  });

  it.each([
    [
      pathLine("/usr/bin", "/opt/bin"),
      ["/custom/bin", "/usr/bin"],
      pathLine("/custom/bin", "/usr/bin", "/opt/bin"),
    ],
    [undefined, ["/custom/bin"], "/custom/bin"],
    ["/usr/bin", [], "/usr/bin"],
    [
      ` /usr/bin ${path.delimiter} ${path.delimiter} /opt/bin `,
      ["/custom/bin"],
      pathLine("/custom/bin", "/usr/bin", "/opt/bin"),
    ],
  ])("merges prepended paths for %j", (existingPath, prepend, expected) => {
    expect(mergePathPrepend(existingPath, prepend)).toBe(expected);
  });

  it("applies prepends to the discovered PATH key and preserves existing casing", () => {
    const envResult = {
      Path: pathLine("/usr/bin", "/opt/bin"),
    };

    applyPathPrepend(envResult, ["/custom/bin", "/usr/bin"]);

    expect(envResult).toEqual({
      Path: pathLine("/custom/bin", "/usr/bin", "/opt/bin"),
    });
  });

  it.each([
    [env({ HOME: "/tmp/home" }), ["/custom/bin"], env({ HOME: "/tmp/home" })],
    [env({ path: "" }), ["/custom/bin"], env({ path: "" })],
    [env({ PATH: "/usr/bin" }), [], env({ PATH: "/usr/bin" })],
    [env({ PATH: "/usr/bin" }), undefined, env({ PATH: "/usr/bin" })],
  ])("respects requireExisting for %j with prepend %j", (envValue, prepend, expected) => {
    applyPathPrepend(envValue, prepend, { requireExisting: true });
    expect(envValue).toEqual(expected);
  });

  it.each([
    {
      name: "creates PATH when prepends are provided and no path key exists",
      env: { HOME: "/tmp/home" },
      prepend: ["/custom/bin"],
      opts: undefined,
      expected: {
        HOME: "/tmp/home",
        PATH: "/custom/bin",
      },
    },
  ])("$name", ({ env: envLocal, prepend, opts, expected }) => {
    applyPathPrepend(envLocal, prepend, opts);
    expect(envLocal).toEqual(expected);
  });

  describe("removePathPrepend", () => {
    it("returns the existing path if prepend is empty", () => {
      expect(removePathPrepend("/usr/bin:/bin", [])).toBe("/usr/bin:/bin");
    });

    it("returns undefined if existing is undefined", () => {
      expect(removePathPrepend(undefined, ["/custom/bin"])).toBeUndefined();
    });

    it("removes prepended entries globally from the existing path", () => {
      // Normal case
      expect(
        removePathPrepend(pathLine("/custom/bin", "/opt/bin", "/usr/bin", "/bin"), [
          "/custom/bin",
          "/opt/bin",
        ]),
      ).toBe(pathLine("/usr/bin", "/bin"));

      // Tampered case (entries exist later in the path)
      expect(
        removePathPrepend(pathLine("/plugin/bin", "/custom/bin", "/opt/bin", "/usr/bin", "/bin"), [
          "/custom/bin",
          "/opt/bin",
        ]),
      ).toBe(pathLine("/plugin/bin", "/usr/bin", "/bin"));

      // Duplicate case (natural path contains duplicate of prepended entry)
      // Since removePathPrepend now uses global filtering, it will remove all instances.
      expect(
        removePathPrepend(pathLine("/custom/bin", "/opt/bin", "/usr/bin", "/custom/bin", "/bin"), [
          "/custom/bin",
          "/opt/bin",
        ]),
      ).toBe(pathLine("/usr/bin", "/bin"));
    });

    it("handles whitespace and blank entries safely", () => {
      expect(
        removePathPrepend(pathLine(" /custom/bin ", " ", "/usr/bin"), ["  /custom/bin  ", ""]),
      ).toBe("/usr/bin");
    });
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPathPrepend,
  findPathKey,
  mergePathPrepend,
  normalizePathPrepend,
} from "./path-prepend.js";

const env = (value: Record<string, string>) => value;

describe("path prepend helpers", () => {
  it.each([
    { env: env({ PATH: "/usr/bin" }), expected: "PATH" },
    { env: env({ Path: "/usr/bin" }), expected: "Path" },
    { env: env({ path: "/usr/bin" }), expected: "path" },
    { env: env({ PaTh: "/usr/bin" }), expected: "PaTh" },
    { env: env({ HOME: "/tmp" }), expected: "PATH" },
  ])("finds the PATH key for %j", ({ env, expected }) => {
    expect(findPathKey(env)).toBe(expected);
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

  it.each([
    {
      existingPath: `/usr/bin${path.delimiter}/opt/bin`,
      prepend: ["/custom/bin", "/usr/bin"],
      expected: ["/custom/bin", "/usr/bin", "/opt/bin"].join(path.delimiter),
    },
    {
      existingPath: undefined,
      prepend: ["/custom/bin"],
      expected: "/custom/bin",
    },
    {
      existingPath: "/usr/bin",
      prepend: [],
      expected: "/usr/bin",
    },
    {
      existingPath: ` /usr/bin ${path.delimiter} ${path.delimiter} /opt/bin `,
      prepend: ["/custom/bin"],
      expected: ["/custom/bin", "/usr/bin", "/opt/bin"].join(path.delimiter),
    },
  ])("merges prepended paths for %j", ({ existingPath, prepend, expected }) => {
    expect(mergePathPrepend(existingPath, prepend)).toBe(expected);
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

  it.each([
    {
      env: env({ HOME: "/tmp/home" }),
      prepend: ["/custom/bin"],
      expected: env({ HOME: "/tmp/home" }),
    },
    {
      env: env({ path: "" }),
      prepend: ["/custom/bin"],
      expected: env({ path: "" }),
    },
    {
      env: env({ PATH: "/usr/bin" }),
      prepend: [],
      expected: env({ PATH: "/usr/bin" }),
    },
    {
      env: env({ PATH: "/usr/bin" }),
      prepend: undefined,
      expected: env({ PATH: "/usr/bin" }),
    },
  ])("respects requireExisting for %j", ({ env, prepend, expected }) => {
    applyPathPrepend(env, prepend, { requireExisting: true });
    expect(env).toEqual(expected);
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

import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPathInside } from "./path-guards.js";
import { createRuntimePathLookup } from "./update-runtime-path-index.js";
import { prepareRuntimeRelocations, relocateRuntimePath } from "./update-runtime-relocation.js";

afterEach(() => vi.unstubAllGlobals());

describe("runtime path ownership", () => {
  it.each(
    [
      {
        platform: "linux",
        roots: ["/work/package", "/work/package/deep", "/work/PACKAGE", "/", "relative"],
        values: [
          "/work/package",
          "/work/package/deep/worker.js",
          "/work/package-other/worker.js",
          "/work/PACKAGE/file",
          "relative/file",
        ],
      },
      {
        platform: "win32",
        roots: [
          "C:\\Work\\Package",
          "c:\\work\\package\\deep",
          "C:\\Work\\Package\\",
          "\\\\server\\share\\package",
          "\\\\?\\C:\\Work\\Package",
          "C:\\",
          "D:\\elsewhere",
          "C:relative",
          "C:\\Work\\Package:stream",
          "\\\\?\\UNC\\server\\share\\package",
        ],
        values: [
          "C:\\Work\\Package",
          "c:/WORK/package/Worker.js",
          "C:\\Work\\Package\\deep\\Worker.js",
          "C:\\Work\\Package-other\\worker.js",
          "\\\\SERVER\\SHARE\\package\\Worker.js",
          "\\\\server\\other\\package\\Worker.js",
          "\\\\?\\C:\\Work\\Package\\Worker.js",
          "\\\\?\\UNC\\server\\share\\package\\Worker.js",
          "C:relative\\file",
          "C:\\Work\\Package:stream",
          "C:\\Work\\Package\\part:stream",
          "\\rooted\\file",
        ],
      },
    ].filter(({ platform }) => platform === "win32" || process.platform !== "win32"),
  )(
    "agrees with the platform guard for matches and exclusions ($platform)",
    ({ platform, roots, values }) => {
      // Only pure lexical operations run while emulating the other platform.
      vi.stubGlobal("process", { ...process, platform });
      for (const ordered of [roots, roots.toReversed()]) {
        const lookup = createRuntimePathLookup(
          ordered.map((root, index) => [root, index] as const),
        );
        for (const value of values) {
          const expected = ordered.findIndex((root) => isPathInside(root, value));
          expect(lookup(value), value).toBe(expected === -1 ? undefined : expected);
        }
      }
      const unrelated = createRuntimePathLookup([[roots[0]!, "owned"]]);
      expect(
        unrelated(platform === "win32" ? "Z:\\outside\\file" : "/outside/file"),
      ).toBeUndefined();
    },
  );

  it("relocates ordered aliases and exact boundaries", () => {
    const at = (relative: string) => path.resolve("runtime-path-rules", relative);
    const makeRule = (source: string, destination: string, ...aliases: string[]) => ({
      sourceRoot: at(source),
      destinationRoot: at(destination),
      sourceAliases: aliases.length ? aliases.map(at) : undefined,
    });
    const rules = [
      makeRule("source", "broad", "alias", "alias/deep"),
      makeRule("source/deep", "narrow"),
      makeRule("source", "narrow"),
    ];
    for (const lookup of [rules, prepareRuntimeRelocations(rules)]) {
      for (const [input, expected] of [
        ["source/deep/file", "broad/deep/file"],
        ["alias/deep/file", "broad/deep/file"],
        ["source-sibling/file", "source-sibling/file"],
      ]) {
        expect(relocateRuntimePath(at(input!), lookup)).toBe(at(expected!));
      }
    }
  });
});

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
          "/work/package/worker.js",
          "/work/package/deep/worker.js",
          "/work/package-other/worker.js",
          "/work/package/../outside",
          "/work/PACKAGE/file",
          "/work/package//deep/./file",
          "/work/package/..hidden/file",
          "/work/package/a:b",
          "/unrelated",
          "relative/file",
          "/work/package ",
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
          "C:\\Work\\Package\\..\\outside",
          "C:\\Work\\Package\\..hidden\\file",
          "D:\\Work\\Package\\file",
          "\\\\SERVER\\SHARE\\package\\Worker.js",
          "\\\\server\\other\\package\\Worker.js",
          "\\\\?\\C:\\Work\\Package\\Worker.js",
          "\\\\?\\UNC\\server\\share\\package\\Worker.js",
          "C:relative\\file",
          "C:\\Work\\Package:stream",
          "C:\\Work\\Package\\part:stream",
          "C:\\Work\\Package \\file",
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

  it("keeps first-rule and first-alias precedence rather than choosing the longest prefix", () => {
    const base = path.resolve("runtime-path-rules");
    const source = path.join(base, "source");
    const broad = path.join(base, "broad");
    const narrow = path.join(base, "narrow");
    const rules = [
      {
        sourceRoot: source,
        destinationRoot: broad,
        sourceAliases: [path.join(base, "alias"), path.join(base, "alias", "deep")],
      },
      { sourceRoot: path.join(source, "deep"), destinationRoot: narrow },
      { sourceRoot: source, destinationRoot: narrow },
    ];
    for (const lookup of [rules, prepareRuntimeRelocations(rules)]) {
      expect(relocateRuntimePath(path.join(source, "deep", "file"), lookup)).toBe(
        path.join(broad, "deep", "file"),
      );
      expect(relocateRuntimePath(path.join(base, "alias", "deep", "file"), lookup)).toBe(
        path.join(broad, "deep", "file"),
      );
      const outside = path.join(base, "source-sibling", "file");
      expect(relocateRuntimePath(outside, lookup)).toBe(outside);
    }
  });

  it("relocates a checkout-sized rule set without confusing sibling prefixes or aliases", () => {
    const base = path.resolve("runtime-path-scale");
    const rules = Array.from({ length: 5_000 }, (_, index) => ({
      sourceRoot: path.join(base, "source", `package-${index}`),
      sourceAliases: [path.join(base, "aliases", `package-${index}`)],
      destinationRoot: path.join(base, "retained", `package-${index}`),
    }));
    const prepared = prepareRuntimeRelocations(rules);
    for (const rule of rules) {
      const suffix = path.join("lib", "Worker.js");
      expect(relocateRuntimePath(path.join(rule.sourceRoot, suffix), prepared)).toBe(
        path.join(rule.destinationRoot, suffix),
      );
      expect(relocateRuntimePath(path.join(rule.sourceAliases[0]!, suffix), prepared)).toBe(
        path.join(rule.destinationRoot, suffix),
      );
      const outside = path.join(`${rule.sourceRoot}-unowned`, suffix);
      expect(relocateRuntimePath(outside, prepared)).toBe(outside);
    }
  });
});

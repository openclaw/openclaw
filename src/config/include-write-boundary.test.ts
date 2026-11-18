import { describe, expect, it } from "vitest";
import {
  collectChangedConfigPaths,
  resolveIncludeWriteBoundary,
} from "./include-write-boundary.js";
import type { ConfigIncludeOwnership } from "./includes.js";

const include = (path: readonly string[], targetPath: string): ConfigIncludeOwnership => ({
  path,
  targetPath,
  kind: "single",
  hasSiblingOverrides: false,
  hasArrayAncestor: false,
});
const alphaInclude = include(["agents", "entries", "alpha"], "/cfg/alpha.json5");

const boundary = (
  provenance: ConfigIncludeOwnership[],
  paths = [[...alphaInclude.path, "model"]],
  rootChanged = false,
) => resolveIncludeWriteBoundary({ provenance, changed: { paths, rootChanged } });

describe("collectChangedConfigPaths", () => {
  it("marks non-record replacements as a root change", () => {
    expect(collectChangedConfigPaths({ a: 1 }, null)).toEqual({ paths: [], rootChanged: true });
  });
});

describe("resolveIncludeWriteBoundary", () => {
  it("prefers the deepest owning include over its sole-owner parent", () => {
    const outer = include(["agents"], "/cfg/agents.json5");
    expect(boundary([alphaInclude, outer])?.includePath).toBe("/cfg/alpha.json5");
  });

  it("declines a nested include merged at the same logical path", () => {
    expect(
      boundary([
        alphaInclude,
        {
          path: alphaInclude.path,
          kind: "multiple" as const,
          hasSiblingOverrides: false,
          hasArrayAncestor: false,
        },
      ]),
    ).toBeNull();
  });

  it("keeps the innermost authored file in a same-path delegation chain", () => {
    // Depth-first include processing records the innermost file before its
    // delegating parent; the outer file still contains a $include directive.
    const outerDelegate = include(alphaInclude.path, "/cfg/alpha-delegate.json5");
    expect(boundary([alphaInclude, outerDelegate])?.includePath).toBe("/cfg/alpha.json5");
  });

  it("declines an include with sibling overrides", () => {
    expect(boundary([{ ...alphaInclude, hasSiblingOverrides: true }])).toBeNull();
  });

  it("declines every nested boundary beneath a sole-owner root include", () => {
    expect(boundary([alphaInclude, include([], "/cfg/base.json5")])).toBeNull();
  });

  it("declines an array-entry include", () => {
    expect(
      boundary(
        [{ ...alphaInclude, path: ["agents", "list", "0"], hasArrayAncestor: true }],
        [["agents", "list", "0", "model"]],
      ),
    ).toBeNull();
  });

  it("declines a root change and an empty change set", () => {
    expect(boundary([alphaInclude], [], true)).toBeNull();
    expect(boundary([alphaInclude], [])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  collectChangedConfigPaths,
  resolveIncludeWriteBoundary,
} from "./include-write-boundary.js";

const alphaInclude = {
  path: ["agents", "entries", "alpha"],
  kind: "single" as const,
  hasSiblingOverrides: false,
  targetPath: "/cfg/alpha.json5",
};

describe("collectChangedConfigPaths", () => {
  it("marks non-record replacements as a root change", () => {
    expect(collectChangedConfigPaths({ a: 1 }, null)).toEqual({ paths: [], rootChanged: true });
  });
});

describe("resolveIncludeWriteBoundary", () => {
  it("prefers the deepest owning include over its sole-owner parent", () => {
    const outer = {
      path: ["agents"],
      kind: "single" as const,
      hasSiblingOverrides: false,
      hasArrayAncestor: false,
      targetPath: "/cfg/agents.json5",
    };
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude, outer],
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      })?.includePath,
    ).toBe("/cfg/alpha.json5");
  });

  it("declines a nested include merged at the same logical path", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [
          alphaInclude,
          {
            path: alphaInclude.path,
            kind: "multiple" as const,
            hasSiblingOverrides: false,
            hasArrayAncestor: false,
          },
        ],
        changed: { paths: [[...alphaInclude.path, "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("keeps the innermost authored file in a same-path delegation chain", () => {
    // Depth-first include processing records the innermost file before its
    // delegating parent; the outer file still contains a $include directive.
    const outerDelegate = {
      path: alphaInclude.path,
      kind: "single" as const,
      hasSiblingOverrides: false,
      hasArrayAncestor: false,
      targetPath: "/cfg/alpha-delegate.json5",
    };
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude, outerDelegate],
        changed: { paths: [[...alphaInclude.path, "model"]], rootChanged: false },
      })?.includePath,
    ).toBe("/cfg/alpha.json5");
  });

  it("declines an include with sibling overrides", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [{ ...alphaInclude, hasSiblingOverrides: true }],
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("declines every nested boundary beneath a sole-owner root include", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [
          alphaInclude,
          {
            path: [],
            kind: "single" as const,
            hasSiblingOverrides: false,
            hasArrayAncestor: false,
            targetPath: "/cfg/base.json5",
          },
        ],
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("declines an array-entry include", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [{ ...alphaInclude, path: ["agents", "list", "0"], hasArrayAncestor: true }],
        changed: { paths: [["agents", "list", "0", "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("declines a root change and an empty change set", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude],
        changed: { paths: [], rootChanged: true },
      }),
    ).toBeNull();
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude],
        changed: { paths: [], rootChanged: false },
      }),
    ).toBeNull();
  });
});

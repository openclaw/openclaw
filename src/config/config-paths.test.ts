import { describe, expect, it, vi } from "vitest";
import {
  parseConcreteConfigPath,
  parseConcreteConfigPathTokens,
  parseConcreteConfigPathWithProvenance,
  tokenizeConcreteConfigPath,
} from "../shared/dot-path.js";
import {
  getConfigValueAtPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "./config-paths.js";

describe("concrete config path readers and mutation guards", () => {
  it.each(["constructor", "prototype", "__proto__"])(
    "reads diagnostic %s keys while all mutation parsers reject them",
    (key) => {
      const path = `tools.media.audio.request.headers.${key}`;
      expect(tokenizeConcreteConfigPath(path).tokens).toEqual([
        "tools",
        "media",
        "audio",
        "request",
        "headers",
        key,
      ]);
      for (const parse of [
        parseConcreteConfigPath,
        parseConcreteConfigPathTokens,
        parseConcreteConfigPathWithProvenance,
      ]) {
        expect(() => parse(path)).toThrow(`Invalid path segment: ${key}`);
      }
    },
  );

  it("retains quoted keys and array-index provenance through the shared grammar", () => {
    const parsed = tokenizeConcreteConfigPath('entries["123"].headers["X.Trace"][0]');
    expect(parsed.tokens).toEqual(["entries", "123", "headers", "X.Trace", 0]);
    expect(parsed.quotedNumericSegments).toEqual(new Set([1]));
    expect(parseConcreteConfigPathWithProvenance('entries["123"].headers["X.Trace"][0]')).toEqual(
      parsed,
    );
  });
});

describe("config path own-property traversal", () => {
  it("does not treat an inherited prototype leaf as config", () => {
    const key = "toString";
    const parent: Record<string, unknown> = {};
    const root: Record<string, unknown> = { parent };

    expect(getConfigValueAtPath(root, ["parent", key])).toBeUndefined();
    expect(unsetConfigValueAtPath(root, ["parent", key])).toBe(false);
    expect(root).toEqual({ parent: {} });

    setConfigValueAtPath(root, ["parent", key], "own");
    expect(Object.hasOwn(parent, key)).toBe(true);
    expect(getConfigValueAtPath(root, ["parent", key])).toBe("own");
    expect(unsetConfigValueAtPath(root, ["parent", key])).toBe(true);
    expect(root).toEqual({});
  });

  it("replaces an inherited parent instead of traversing it", () => {
    const prototypeBranch = { leaf: "prototype" };
    const root = Object.create({ branch: prototypeBranch }) as Record<string, unknown>;

    expect(getConfigValueAtPath(root, ["branch", "leaf"])).toBeUndefined();
    expect(unsetConfigValueAtPath(root, ["branch", "leaf"])).toBe(false);
    expect(prototypeBranch).toEqual({ leaf: "prototype" });

    setConfigValueAtPath(root, ["branch", "leaf"], "own");
    expect(Object.hasOwn(root, "branch")).toBe(true);
    expect(root.branch).toEqual({ leaf: "own" });
    expect(prototypeBranch).toEqual({ leaf: "prototype" });

    expect(unsetConfigValueAtPath(root, ["branch", "leaf"])).toBe(true);
    expect(Object.hasOwn(root, "branch")).toBe(false);
    expect(getConfigValueAtPath(root, ["branch", "leaf"])).toBeUndefined();
    expect(prototypeBranch).toEqual({ leaf: "prototype" });
  });

  for (const inheritedKind of ["setter", "non-writable"] as const) {
    it(`creates an own parent over an inherited ${inheritedKind} property`, () => {
      const setter = vi.fn();
      const prototype = {};
      Object.defineProperty(
        prototype,
        "branch",
        inheritedKind === "setter"
          ? { configurable: true, set: setter }
          : { configurable: true, value: { leaf: "prototype" }, writable: false },
      );
      const root = Object.create(prototype) as Record<string, unknown>;

      expect(() => setConfigValueAtPath(root, ["branch", "leaf"], "own")).not.toThrow();
      expect(setter).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptor(root, "branch")).toMatchObject({
        configurable: true,
        enumerable: true,
        value: { leaf: "own" },
        writable: true,
      });
    });

    it(`creates an own leaf over an inherited ${inheritedKind} property`, () => {
      const setter = vi.fn();
      const prototype = {};
      Object.defineProperty(
        prototype,
        "leaf",
        inheritedKind === "setter"
          ? { configurable: true, set: setter }
          : { configurable: true, value: "prototype", writable: false },
      );
      const parent = Object.create(prototype) as Record<string, unknown>;
      const root = { parent };

      expect(() => setConfigValueAtPath(root, ["parent", "leaf"], "own")).not.toThrow();
      expect(setter).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptor(parent, "leaf")).toMatchObject({
        configurable: true,
        enumerable: true,
        value: "own",
        writable: true,
      });
    });
  }
});

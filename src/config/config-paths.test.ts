import { describe, expect, it, vi } from "vitest";
import {
  parseConcreteConfigPath,
  parseConcreteConfigPathTokens,
  parseConcreteConfigPathWithProvenance,
  readObjectPath,
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
  it.each([
    ["agents.defaults.model", "fallbacks", ["openai/gpt-4o"]],
    ["agents.defaults.utilityModel", "fallbacks", ["openai/gpt-4o"]],
    ["agents.entries.worker.utilityModel", "fallbacks", ["openai/gpt-4o"]],
    ["agents.defaults.subagents.model", "fallbacks", ["openai/gpt-4o"]],
    ["agents.entries.worker.model", "fallbacks", ["openai/gpt-4o"]],
    ["agents.entries.worker.subagents.model", "fallbacks", ["openai/gpt-4o"]],
    ["tools.exec.reviewer.model", "fallbacks", ["openai/gpt-4o"]],
    ["agents.entries.worker.tools.exec.reviewer.model", "fallbacks", ["openai/gpt-4o"]],
    ["agents.defaults.pdfModel", "timeoutMs", 5000],
    ["agents.defaults.mediaModels.video", "timeoutMs", 5000],
  ] as const)("keeps a shorthand primary when setting %s.%s", (path, member, value) => {
    const parent = path.split(".");
    const root: Record<string, unknown> = {};
    setConfigValueAtPath(root, parent, "openai/gpt-4o-mini");
    setConfigValueAtPath(root, [...parent, member], value);
    expect(getConfigValueAtPath(root, parent)).toEqual({
      primary: "openai/gpt-4o-mini",
      [member]: value,
    });
  });

  it.each(["agents.defaults.utilityModel", "agents.entries.worker.utilityModel"])(
    "keeps utility routing disabled when adding fallbacks at %s",
    (path) => {
      const parent = path.split(".");
      const root: Record<string, unknown> = {};
      setConfigValueAtPath(root, parent, "");
      setConfigValueAtPath(root, [...parent, "fallbacks"], ["local/backup"]);
      expect(getConfigValueAtPath(root, parent)).toEqual({
        primary: "",
        fallbacks: ["local/backup"],
      });
    },
  );

  it.each([
    { member: "fallbacks", value: ["backup"] },
    { member: "timeoutMs", value: 5000 },
  ])("does not promote unrelated plugin strings when setting $member", ({ member, value }) => {
    const root = { plugins: { entries: { demo: { config: { model: "opaque" } } } } };
    setConfigValueAtPath(root, ["plugins", "entries", "demo", "config", "model", member], value);
    expect(root.plugins.entries.demo.config.model).toEqual({ [member]: value });
  });

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

  function inheritedProperty(key: string, kind: "setter" | "non-writable", value: unknown) {
    const setter = vi.fn();
    const prototype = {};
    Object.defineProperty(
      prototype,
      key,
      kind === "setter"
        ? { configurable: true, set: setter }
        : { configurable: true, value, writable: false },
    );
    return { setter, object: Object.create(prototype) as Record<string, unknown> };
  }
  function expectOwnProperty(object: object, key: string, value: unknown) {
    expect(Object.getOwnPropertyDescriptor(object, key)).toMatchObject({
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }

  for (const inheritedKind of ["setter", "non-writable"] as const) {
    it(`creates an own parent over an inherited ${inheritedKind} property`, () => {
      const { setter, object: root } = inheritedProperty("branch", inheritedKind, {
        leaf: "prototype",
      });

      expect(() => setConfigValueAtPath(root, ["branch", "leaf"], "own")).not.toThrow();
      expect(setter).not.toHaveBeenCalled();
      expectOwnProperty(root, "branch", { leaf: "own" });
    });

    it(`creates an own leaf over an inherited ${inheritedKind} property`, () => {
      const { setter, object: parent } = inheritedProperty("leaf", inheritedKind, "prototype");
      const root = { parent };

      expect(() => setConfigValueAtPath(root, ["parent", "leaf"], "own")).not.toThrow();
      expect(setter).not.toHaveBeenCalled();
      expectOwnProperty(parent, "leaf", "own");
    });
  }
});

describe("raw diagnostic path traversal", () => {
  it.each([
    ["raw", ["first", "named", 1, "inherited"]],
    ["canonical", ["first", undefined, undefined, "inherited"]],
    ["bounded", ["first", undefined, undefined, undefined]],
  ] as const)("retains the %s array-key policy", (mode, expected) => {
    const values = Object.assign(["first"], { named: "named" });
    Object.setPrototypeOf(
      values,
      Object.assign(Object.create(Array.prototype), { 2: "inherited" }),
    );
    expect(["0", "named", "length", "2"].map((key) => readObjectPath(values, [key], mode))).toEqual(
      expected,
    );
  });

  it.each([
    [{ values: [{ leaf: "array" }] }, ["values", "0", "leaf"], "array"],
    [Object.create({ inherited: { leaf: "prototype" } }), ["inherited", "leaf"], "prototype"],
    [{ missing: null }, ["missing", "leaf"], undefined],
    [{ value: "text" }, ["value", "length"], undefined],
  ] as const)("reads %j at %j", (root, path, expected) => {
    expect(readObjectPath(root, path)).toBe(expected);
  });

  it("retains root identity for an empty path", () => {
    const root = { leaf: "value" };
    expect(readObjectPath(root, [])).toBe(root);
  });

  it("propagates the original property getter failure", () => {
    const failure = new Error("getter failed");
    const root = Object.defineProperty({}, "value", {
      get() {
        throw failure;
      },
    });
    expect(() => readObjectPath(root, ["value"])).toThrow(failure);
  });
});

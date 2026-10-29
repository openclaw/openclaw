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
      expect(tokenizeConcreteConfigPath(path).tokens).toEqual(path.split("."));
      for (const parse of [
        parseConcreteConfigPath,
        parseConcreteConfigPathTokens,
        parseConcreteConfigPathWithProvenance,
      ]) {
        expect(() => parse(path)).toThrow(`Invalid path segment: ${key}`);
      }
    },
  );
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
    ["agents.defaults.utilityModel", "fallbacks", ["local/backup"], ""],
    ["agents.entries.worker.utilityModel", "fallbacks", ["local/backup"], ""],
  ] as const)(
    "keeps the authored primary when setting %s.%s",
    (path, member, value, configuredPrimary?: string) => {
      const primary = configuredPrimary ?? "openai/gpt-4o-mini";
      const parent = path.split(".");
      const root: Record<string, unknown> = {};
      setConfigValueAtPath(root, parent, primary);
      setConfigValueAtPath(root, [...parent, member], value);
      expect(getConfigValueAtPath(root, parent)).toEqual({
        primary,
        [member]: value,
      });
    },
  );

  it.each(["parent", "leaf"])(
    "ignores inherited %s properties during read, write and unset",
    (location) => {
      const inherited = { leaf: "prototype" };
      const root: Record<string, unknown> =
        location === "parent"
          ? Object.create({ branch: inherited })
          : { branch: Object.create(inherited) };
      const path = ["branch", "leaf"];
      expect(getConfigValueAtPath(root, path)).toBeUndefined();
      expect(unsetConfigValueAtPath(root, path)).toBe(false);
      setConfigValueAtPath(root, path, "own");
      expect(root).toEqual({ branch: { leaf: "own" } });
      expect(getConfigValueAtPath(root, path)).toBe("own");
      expect(unsetConfigValueAtPath(root, path)).toBe(true);
      expect(root).toEqual({});
      expect(inherited).toEqual({ leaf: "prototype" });
    },
  );

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

  it.each([
    ["setter", "parent"],
    ["setter", "leaf"],
    ["non-writable", "parent"],
    ["non-writable", "leaf"],
  ] as const)("creates an own %s-shadowing %s", (kind, location) => {
    const isParent = location === "parent";
    const key = isParent ? "branch" : "leaf";
    const { setter, object } = inheritedProperty(
      key,
      kind,
      isParent ? { leaf: "prototype" } : "prototype",
    );
    setConfigValueAtPath(isParent ? object : { branch: object }, ["branch", "leaf"], "own");
    expect(setter).not.toHaveBeenCalled();
    expectOwnProperty(object, key, isParent ? { leaf: "own" } : "own");
  });
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

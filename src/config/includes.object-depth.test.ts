// Covers the object/array traversal depth guard for deeply nested configs.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigIncludeError,
  type IncludeResolver,
  MAX_CONFIG_OBJECT_DEPTH,
  resolveConfigIncludes,
} from "./includes.js";

const ROOT_DIR = path.parse(process.cwd()).root;
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const DEFAULT_BASE_PATH = path.join(CONFIG_DIR, "openclaw.json");

function createMockResolver(files: Record<string, unknown>): IncludeResolver {
  return {
    readFile: (filePath: string) => {
      if (filePath in files) {
        return JSON.stringify(files[filePath]);
      }
      throw new Error(`ENOENT: no such file: ${filePath}`);
    },
    parseJson: JSON.parse,
  };
}

function resolve(obj: unknown, files: Record<string, unknown> = {}) {
  return resolveConfigIncludes(obj, DEFAULT_BASE_PATH, createMockResolver(files));
}

function nestedObjects(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i += 1) {
    value = { x: value };
  }
  return value;
}

function nestedArrays(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i += 1) {
    value = [value];
  }
  return value;
}

function expectConfigDepthError(run: () => unknown): ConfigIncludeError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigIncludeError);
  expect((thrown as Error).message).toContain(String(MAX_CONFIG_OBJECT_DEPTH));
  return thrown as ConfigIncludeError;
}

describe("resolveConfigIncludes object depth guard", () => {
  it("resolves nesting just under the depth cap unchanged", () => {
    const value = nestedObjects(MAX_CONFIG_OBJECT_DEPTH - 1);
    expect(resolve(value)).toEqual(value);
  });

  it("rejects deeply nested objects with a clean error instead of a stack overflow", () => {
    // Far past the call-stack overflow point, so the guard - not RangeError -
    // answers the pathological document.
    const value = nestedObjects(100_000);
    expectConfigDepthError(() => resolve(value));
  });

  it("counts array nesting toward the same budget", () => {
    const value = nestedArrays(100_000);
    expectConfigDepthError(() => resolve(value));
  });

  it("shares one budget across the include file chain", () => {
    // The $include sits 480 levels deep; its file adds 100 more. A per-file
    // budget would resolve this chain and overflow on deeper ones instead.
    let obj: unknown = { $include: "./deep.json" };
    for (let i = 0; i < 480; i += 1) {
      obj = { x: obj };
    }
    const files = { [path.join(CONFIG_DIR, "deep.json")]: nestedObjects(100) };
    expectConfigDepthError(() => resolve(obj, files));
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type IncludeResolver,
  resolveConfigIncludes,
  resolveConfigIncludesForTopLevelKey,
} from "./includes.js";

const CONFIG_DIR = path.join(path.parse(process.cwd()).root, "config");
const DEFAULT_BASE_PATH = path.join(CONFIG_DIR, "openclaw.json");

function configPath(name: string): string {
  return path.join(CONFIG_DIR, name);
}

function createMockResolver(files: Record<string, unknown>): IncludeResolver {
  return {
    readFile: (filePath) => {
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

// Walks the resolved tree iteratively: a recursive toEqual would overflow the
// test's own call stack at the depths under test.
function expectNestedPath(value: unknown, depth: number, key: string, leaf: unknown): void {
  let current = value;
  for (let i = 0; i < depth; i += 1) {
    expect(current).toBeTypeOf("object");
    expect(current).not.toBeNull();
    const container = current as Record<string, unknown>;
    expect(Object.keys(container)).toEqual([key]);
    current = container[key];
  }
  expect(current).toBe(leaf);
}

describe("resolveConfigIncludesForTopLevelKey", () => {
  it("projects through root includes without resolving malformed siblings", () => {
    const files = {
      [configPath("defaults.json")]: {
        logging: { consoleStyle: "pretty", level: "debug" },
        plugins: { $include: "./missing-plugins.json" },
      },
      [configPath("override.json")]: {
        logging: { consoleStyle: "json" },
      },
    };

    expect(
      resolveConfigIncludesForTopLevelKey(
        {
          $include: ["./defaults.json", "./override.json"],
          logging: { level: "info" },
          agents: { $include: "./missing-agents.json" },
        },
        DEFAULT_BASE_PATH,
        "logging",
        createMockResolver(files),
      ),
    ).toEqual({ logging: { consoleStyle: "json", level: "info" } });
  });
});

// The resolver walks nested documents on an explicit work stack, so document
// depth costs heap instead of call frames and previously accepted deep values
// keep loading.
describe("resolveConfigIncludes deep nesting", () => {
  it("resolves object nesting past the previously rejected depth budget", () => {
    expectNestedPath(resolve(nestedObjects(600)), 600, "x", "leaf");
  });

  it("resolves thousands of nested objects instead of overflowing the call stack", () => {
    expectNestedPath(resolve(nestedObjects(4_000)), 4_000, "x", "leaf");
  });

  it("resolves 100,000-level object documents on the work stack", () => {
    expectNestedPath(resolve(nestedObjects(100_000)), 100_000, "x", "leaf");
  });

  it("resolves 100,000-level array documents on the work stack", () => {
    expectNestedPath(resolve(nestedArrays(100_000)), 100_000, "0", "leaf");
  });

  it("resolves deep nesting carried across the include file chain", () => {
    // The $include sits 480 levels deep and its file adds 100 more; the
    // segments and their sum must resolve without any per-document budget.
    let obj: unknown = { $include: "./deep.json" };
    for (let i = 0; i < 480; i += 1) {
      obj = { x: obj };
    }
    const files = { [configPath("deep.json")]: nestedObjects(100) };
    expectNestedPath(resolve(obj, files), 580, "x", "leaf");
  });
});

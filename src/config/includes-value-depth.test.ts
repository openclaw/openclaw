// Covers the config value-nesting depth guard for deeply nested documents.
// Extracted into a sibling module so includes.test.ts stays within the
// max-lines budget; the guard itself lives in ./includes.ts.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigIncludeError, type IncludeResolver, resolveConfigIncludes } from "./includes.js";

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

function resolve(obj: unknown, files: Record<string, unknown> = {}, basePath = DEFAULT_BASE_PATH) {
  return resolveConfigIncludes(obj, basePath, createMockResolver(files));
}

describe("resolveConfigIncludes value nesting depth guard", () => {
  it("rejects deeply nested config values instead of overflowing the stack", () => {
    // A single document with no $include still recurses through every nested
    // value. Past the internal cap (100) this must fail with a clear
    // ConfigIncludeError, not "RangeError: Maximum call stack size exceeded".
    // 200 levels is well past the cap.
    let value: unknown = { leaf: true };
    for (let i = 0; i < 200; i += 1) {
      value = { x: value };
    }
    expect(() => resolve(value)).toThrow(ConfigIncludeError);
    expect(() => resolve(value)).toThrow(/Maximum config nesting depth/);
  });

  it("resolves config values nested within the maximum depth", () => {
    let value: unknown = { leaf: true };
    for (let i = 0; i < 10; i += 1) {
      value = { x: value };
    }
    expect(() => resolve(value)).not.toThrow();
  });
});

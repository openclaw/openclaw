import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CircularIncludeError,
  ConfigIncludeError,
  deepMerge,
  type IncludeResolver,
  resolveConfigIncludes,
} from "./includes.js";

const ROOT_DIR = path.parse(process.cwd()).root;
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const ETC_OPENCLAW_DIR = path.join(ROOT_DIR, "etc", "openclaw");
const SHARED_DIR = path.join(ROOT_DIR, "shared");

const DEFAULT_BASE_PATH = path.join(CONFIG_DIR, "openclaw.json");

function configPath(...parts: string[]) {
  return path.join(CONFIG_DIR, ...parts);
}

function etcOpenClawPath(...parts: string[]) {
  return path.join(ETC_OPENCLAW_DIR, ...parts);
}

function sharedPath(...parts: string[]) {
  return path.join(SHARED_DIR, ...parts);
}

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

describe("resolveConfigIncludes", () => {
  it("passes through primitives unchanged", () => {
    expect(resolve("hello")).toBe("hello");
    expect(resolve(42)).toBe(42);
    expect(resolve(true)).toBe(true);
    expect(resolve(null)).toBe(null);
  });

  it("passes through arrays with recursion", () => {
    expect(resolve([1, 2, { a: 1 }])).toEqual([1, 2, { a: 1 }]);
  });

  it("passes through objects without $include", () => {
    const obj = { foo: "bar", nested: { x: 1 } };
    expect(resolve(obj)).toEqual(obj);
  });

  it("resolves single file $include", () => {
    const files = { [configPath("agents.json")]: { list: [{ id: "main" }] } };
    const obj = { agents: { $include: "./agents.json" } };
    expect(resolve(obj, files)).toEqual({
      agents: { list: [{ id: "main" }] },
    });
  });

  it("rejects absolute path outside config directory (CWE-22)", () => {
    const absolute = etcOpenClawPath("agents.json");
    const files = { [absolute]: { list: [{ id: "main" }] } };
    const obj = { agents: { $include: absolute } };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(/escapes config directory/);
  });

  it("resolves array $include with deep merge", () => {
    const files = {
      [configPath("a.json")]: { "group-a": ["agent1"] },
      [configPath("b.json")]: { "group-b": ["agent2"] },
    };
    const obj = { broadcast: { $include: ["./a.json", "./b.json"] } };
    expect(resolve(obj, files)).toEqual({
      broadcast: {
        "group-a": ["agent1"],
        "group-b": ["agent2"],
      },
    });
  });

  it("deep merges overlapping keys in array $include", () => {
    const files = {
      [configPath("a.json")]: { agents: { defaults: { workspace: "~/a" } } },
      [configPath("b.json")]: { agents: { list: [{ id: "main" }] } },
    };
    const obj = { $include: ["./a.json", "./b.json"] };
    expect(resolve(obj, files)).toEqual({
      agents: {
        defaults: { workspace: "~/a" },
        list: [{ id: "main" }],
      },
    });
  });

  it("merges $include with sibling keys", () => {
    const files = { [configPath("base.json")]: { a: 1, b: 2 } };
    const obj = { $include: "./base.json", c: 3 };
    expect(resolve(obj, files)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("sibling keys override included values", () => {
    const files = { [configPath("base.json")]: { a: 1, b: 2 } };
    const obj = { $include: "./base.json", b: 99 };
    expect(resolve(obj, files)).toEqual({ a: 1, b: 99 });
  });

  it("throws when sibling keys are used with non-object includes", () => {
    const files = { [configPath("list.json")]: ["a", "b"] };
    const obj = { $include: "./list.json", extra: true };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(
      /Sibling keys require included content to be an object/,
    );
  });

  it("throws when sibling keys are used with primitive includes", () => {
    const files = { [configPath("value.json")]: "hello" };
    const obj = { $include: "./value.json", extra: true };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(
      /Sibling keys require included content to be an object/,
    );
  });

  it("resolves nested includes", () => {
    const files = {
      [configPath("level1.json")]: { nested: { $include: "./level2.json" } },
      [configPath("level2.json")]: { deep: "value" },
    };
    const obj = { $include: "./level1.json" };
    expect(resolve(obj, files)).toEqual({
      nested: { deep: "value" },
    });
  });

  it("throws ConfigIncludeError for missing file", () => {
    const obj = { $include: "./missing.json" };
    expect(() => resolve(obj)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj)).toThrow(/Failed to read include file/);
  });

  it("throws ConfigIncludeError for invalid JSON", () => {
    const resolver: IncludeResolver = {
      readFile: () => "{ invalid json }",
      parseJson: JSON.parse,
    };
    const obj = { $include: "./bad.json" };
    expect(() => resolveConfigIncludes(obj, DEFAULT_BASE_PATH, resolver)).toThrow(
      ConfigIncludeError,
    );
    expect(() => resolveConfigIncludes(obj, DEFAULT_BASE_PATH, resolver)).toThrow(
      /Failed to parse include file/,
    );
  });

  it("throws CircularIncludeError for circular includes", () => {
    const aPath = configPath("a.json");
    const bPath = configPath("b.json");
    const resolver: IncludeResolver = {
      readFile: (filePath: string) => {
        if (filePath === aPath) {
          return JSON.stringify({ $include: "./b.json" });
        }
        if (filePath === bPath) {
          return JSON.stringify({ $include: "./a.json" });
        }
        throw new Error(`Unknown file: ${filePath}`);
      },
      parseJson: JSON.parse,
    };
    const obj = { $include: "./a.json" };
    try {
      resolveConfigIncludes(obj, DEFAULT_BASE_PATH, resolver);
      throw new Error("expected circular include error");
    } catch (err) {
      expect(err).toBeInstanceOf(CircularIncludeError);
      const circular = err as CircularIncludeError;
      expect(circular.chain).toEqual(expect.arrayContaining([DEFAULT_BASE_PATH, aPath, bPath]));
      expect(circular.message).toMatch(/Circular include detected/);
      expect(circular.message).toContain("a.json");
      expect(circular.message).toContain("b.json");
    }
  });

  it("throws ConfigIncludeError for invalid $include value type", () => {
    const obj = { $include: 123 };
    expect(() => resolve(obj)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj)).toThrow(/expected string or array/);
  });

  it("throws ConfigIncludeError for invalid array item type", () => {
    const files = { [configPath("valid.json")]: { valid: true } };
    const obj = { $include: ["./valid.json", 123] };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(/expected string, got number/);
  });

  it("throws ConfigIncludeError for null/boolean include items", () => {
    const files = { [configPath("valid.json")]: { valid: true } };
    const cases = [
      { value: null, expected: "object" },
      { value: false, expected: "boolean" },
    ];
    for (const item of cases) {
      const obj = { $include: ["./valid.json", item.value] };
      expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
      expect(() => resolve(obj, files)).toThrow(
        new RegExp(`expected string, got ${item.expected}`),
      );
    }
  });

  it("respects max depth limit", () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) {
      files[configPath(`level${i}.json`)] = {
        $include: `./level${i + 1}.json`,
      };
    }
    files[configPath("level15.json")] = { done: true };

    const obj = { $include: "./level0.json" };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(/Maximum include depth/);
  });

  it("allows depth 10 but rejects depth 11", () => {
    const okFiles: Record<string, unknown> = {};
    for (let i = 0; i < 9; i++) {
      okFiles[configPath(`ok${i}.json`)] = { $include: `./ok${i + 1}.json` };
    }
    okFiles[configPath("ok9.json")] = { done: true };
    expect(resolve({ $include: "./ok0.json" }, okFiles)).toEqual({
      done: true,
    });

    const failFiles: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      failFiles[configPath(`fail${i}.json`)] = {
        $include: `./fail${i + 1}.json`,
      };
    }
    failFiles[configPath("fail10.json")] = { done: true };
    expect(() => resolve({ $include: "./fail0.json" }, failFiles)).toThrow(ConfigIncludeError);
    expect(() => resolve({ $include: "./fail0.json" }, failFiles)).toThrow(/Maximum include depth/);
  });

  it("handles relative paths correctly", () => {
    const files = {
      [configPath("clients", "mueller", "agents.json")]: { id: "mueller" },
    };
    const obj = { agent: { $include: "./clients/mueller/agents.json" } };
    expect(resolve(obj, files)).toEqual({
      agent: { id: "mueller" },
    });
  });

  it("applies nested includes before sibling overrides", () => {
    const files = {
      [configPath("base.json")]: { nested: { $include: "./nested.json" } },
      [configPath("nested.json")]: { a: 1, b: 2 },
    };
    const obj = { $include: "./base.json", nested: { b: 9 } };
    expect(resolve(obj, files)).toEqual({
      nested: { a: 1, b: 9 },
    });
  });

  it("rejects parent directory traversal escaping config directory (CWE-22)", () => {
    const files = { [sharedPath("common.json")]: { shared: true } };
    const obj = { $include: "../../shared/common.json" };
    expect(() => resolve(obj, files, configPath("sub", "openclaw.json"))).toThrow(
      ConfigIncludeError,
    );
    expect(() => resolve(obj, files, configPath("sub", "openclaw.json"))).toThrow(
      /escapes config directory/,
    );
  });

  it("allows nested parent traversal when path stays under top-level config directory", () => {
    const files = {
      [configPath("sub", "child.json")]: { $include: "../shared/common.json" },
      [configPath("shared", "common.json")]: { shared: true },
    };
    const obj = { $include: "./sub/child.json" };
    expect(resolve(obj, files)).toEqual({
      shared: true,
    });
  });
});

describe("real-world config patterns", () => {
  it("supports per-client agent includes", () => {
    const files = {
      [configPath("clients", "mueller.json")]: {
        agents: [
          {
            id: "mueller-screenshot",
            workspace: "~/clients/mueller/screenshot",
          },
          {
            id: "mueller-transcribe",
            workspace: "~/clients/mueller/transcribe",
          },
        ],
        broadcast: {
          "group-mueller": ["mueller-screenshot", "mueller-transcribe"],
        },
      },
      [configPath("clients", "schmidt.json")]: {
        agents: [
          {
            id: "schmidt-screenshot",
            workspace: "~/clients/schmidt/screenshot",
          },
        ],
        broadcast: { "group-schmidt": ["schmidt-screenshot"] },
      },
    };

    const obj = {
      gateway: { port: 18789 },
      $include: ["./clients/mueller.json", "./clients/schmidt.json"],
    };

    expect(resolve(obj, files)).toEqual({
      gateway: { port: 18789 },
      agents: [
        { id: "mueller-screenshot", workspace: "~/clients/mueller/screenshot" },
        { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
        { id: "schmidt-screenshot", workspace: "~/clients/schmidt/screenshot" },
      ],
      broadcast: {
        "group-mueller": ["mueller-screenshot", "mueller-transcribe"],
        "group-schmidt": ["schmidt-screenshot"],
      },
    });
  });

  it("supports modular config structure", () => {
    const files = {
      [configPath("gateway.json")]: {
        gateway: { port: 18789, bind: "loopback" },
      },
      [configPath("channels", "whatsapp.json")]: {
        channels: { whatsapp: { dmPolicy: "pairing", allowFrom: ["+49123"] } },
      },
      [configPath("agents", "defaults.json")]: {
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
    };

    const obj = {
      $include: ["./gateway.json", "./channels/whatsapp.json", "./agents/defaults.json"],
    };

    expect(resolve(obj, files)).toEqual({
      gateway: { port: 18789, bind: "loopback" },
      channels: { whatsapp: { dmPolicy: "pairing", allowFrom: ["+49123"] } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
  });
});
describe("security: path traversal protection (CWE-22)", () => {
  describe("absolute path attacks", () => {
    it("rejects /etc/passwd", () => {
      const obj = { $include: "/etc/passwd" };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
      expect(() => resolve(obj, {})).toThrow(/escapes config directory/);
    });

    it("rejects /etc/shadow", () => {
      const obj = { $include: "/etc/shadow" };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
      expect(() => resolve(obj, {})).toThrow(/escapes config directory/);
    });

    it("rejects home directory SSH key", () => {
      const obj = { $include: `${process.env.HOME}/.ssh/id_rsa` };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
    });

    it("rejects /tmp paths", () => {
      const obj = { $include: "/tmp/malicious.json" };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
    });

    it("rejects root directory", () => {
      const obj = { $include: "/" };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
    });
  });

  describe("relative traversal attacks", () => {
    it("rejects ../../etc/passwd", () => {
      const obj = { $include: "../../etc/passwd" };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
      expect(() => resolve(obj, {})).toThrow(/escapes config directory/);
    });

    it("rejects ../../../etc/shadow", () => {
      const obj = { $include: "../../../etc/shadow" };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
    });

    it("rejects deeply nested traversal", () => {
      const obj = { $include: "../../../../../../../../etc/passwd" };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
    });

    it("rejects traversal to parent of config directory", () => {
      const obj = { $include: "../sibling-dir/secret.json" };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
    });

    it("rejects mixed absolute and traversal", () => {
      const obj = { $include: "/config/../../../etc/passwd" };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
    });
  });

  describe("legitimate includes (should work)", () => {
    it("allows relative include in same directory", () => {
      const files = { [configPath("sub.json")]: { key: "value" } };
      const obj = { $include: "./sub.json" };
      expect(resolve(obj, files)).toEqual({ key: "value" });
    });

    it("allows include without ./ prefix", () => {
      const files = { [configPath("sub.json")]: { key: "value" } };
      const obj = { $include: "sub.json" };
      expect(resolve(obj, files)).toEqual({ key: "value" });
    });

    it("allows include in subdirectory", () => {
      const files = { [configPath("sub", "nested.json")]: { nested: true } };
      const obj = { $include: "./sub/nested.json" };
      expect(resolve(obj, files)).toEqual({ nested: true });
    });

    it("allows deeply nested subdirectory", () => {
      const files = { [configPath("a", "b", "c", "deep.json")]: { deep: true } };
      const obj = { $include: "./a/b/c/deep.json" };
      expect(resolve(obj, files)).toEqual({ deep: true });
    });

    // Note: Upward traversal from nested configs is restricted for security.
    // Each config file can only include files from its own directory and subdirectories.
    // This prevents potential path traversal attacks even in complex nested scenarios.
  });

  describe("error properties", () => {
    it("throws ConfigIncludeError with correct type", () => {
      const obj = { $include: "/etc/passwd" };
      try {
        resolve(obj, {});
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigIncludeError);
        expect(err).toHaveProperty("name", "ConfigIncludeError");
      }
    });

    it("includes offending path in error", () => {
      const maliciousPath = "/etc/shadow";
      const obj = { $include: maliciousPath };
      try {
        resolve(obj, {});
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigIncludeError);
        expect((err as ConfigIncludeError).includePath).toBe(maliciousPath);
      }
    });

    it("includes descriptive message", () => {
      const obj = { $include: "../../etc/passwd" };
      try {
        resolve(obj, {});
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigIncludeError);
        expect((err as Error).message).toContain("escapes config directory");
        expect((err as Error).message).toContain("../../etc/passwd");
      }
    });
  });

  describe("array includes with malicious paths", () => {
    it("rejects array with one malicious path", () => {
      const files = { [configPath("good.json")]: { good: true } };
      const obj = { $include: ["./good.json", "/etc/passwd"] };
      expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    });

    it("rejects array with multiple malicious paths", () => {
      const obj = { $include: ["/etc/passwd", "/etc/shadow"] };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
    });

    it("allows array with all legitimate paths", () => {
      const files = {
        [configPath("a.json")]: { a: 1 },
        [configPath("b.json")]: { b: 2 },
      };
      const obj = { $include: ["./a.json", "./b.json"] };
      expect(resolve(obj, files)).toEqual({ a: 1, b: 2 });
    });
  });

  describe("prototype pollution protection", () => {
    it("blocks __proto__ keys from polluting Object.prototype", () => {
      const result = deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}'));
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
      expect(result).toEqual({});
    });

    it("blocks prototype and constructor keys", () => {
      const result = deepMerge(
        { safe: 1 },
        { prototype: { x: 1 }, constructor: { y: 2 }, normal: 3 },
      );
      expect(result).toEqual({ safe: 1, normal: 3 });
    });

    it("blocks __proto__ in nested merges", () => {
      const result = deepMerge(
        { nested: { a: 1 } },
        { nested: JSON.parse('{"__proto__":{"polluted":true}}') },
      );
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
      expect(result).toEqual({ nested: { a: 1 } });
    });
  });

  describe("edge cases", () => {
    it("rejects null bytes in path", () => {
      const obj = { $include: "./file\x00.json" };
      // Path with null byte should be rejected or handled safely
      expect(() => resolve(obj, {})).toThrow();
    });

    it("rejects double slashes", () => {
      const obj = { $include: "//etc/passwd" };
      expect(() => resolve(obj, {})).toThrow(ConfigIncludeError);
    });

    it("allows child include when config is at filesystem root", () => {
      const rootConfigPath = path.join(path.parse(process.cwd()).root, "test.json");
      const childPath = path.join(path.parse(process.cwd()).root, "child.json");
      const files = { [childPath]: { root: true } };
      const obj = { $include: childPath };
      expect(resolve(obj, files, rootConfigPath)).toEqual({ root: true });
    });

    it("allows include files when the config root path is a symlink", async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-includes-symlink-"));
      try {
        const realRoot = path.join(tempRoot, "real");
        const linkRoot = path.join(tempRoot, "link");
        await fs.mkdir(path.join(realRoot, "includes"), { recursive: true });
        await fs.writeFile(
          path.join(realRoot, "includes", "extra.json5"),
          "{ logging: { redactSensitive: 'tools' } }\n",
          "utf-8",
        );
        await fs.symlink(realRoot, linkRoot);

        const result = resolveConfigIncludes(
          { $include: "./includes/extra.json5" },
          path.join(linkRoot, "openclaw.json"),
        );
        expect(result).toEqual({ logging: { redactSensitive: "tools" } });
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });
  });
});

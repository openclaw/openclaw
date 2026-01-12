import { describe, expect, it } from "vitest";

import {
  CircularIncludeError,
  ConfigIncludeError,
  type IncludeResolver,
  resolveConfigIncludes,
} from "./includes.js";

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

function resolve(
  obj: unknown,
  files: Record<string, unknown> = {},
  basePath = "/config/clawdbot.json",
) {
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
    const files = { "/config/agents.json": { list: [{ id: "main" }] } };
    const obj = { agents: { $include: "./agents.json" } };
    expect(resolve(obj, files)).toEqual({
      agents: { list: [{ id: "main" }] },
    });
  });

  it("resolves absolute path $include", () => {
    const files = { "/etc/clawdbot/agents.json": { list: [{ id: "main" }] } };
    const obj = { agents: { $include: "/etc/clawdbot/agents.json" } };
    expect(resolve(obj, files)).toEqual({
      agents: { list: [{ id: "main" }] },
    });
  });

  it("resolves array $include with deep merge", () => {
    const files = {
      "/config/a.json": { "group-a": ["agent1"] },
      "/config/b.json": { "group-b": ["agent2"] },
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
      "/config/a.json": { agents: { defaults: { workspace: "~/a" } } },
      "/config/b.json": { agents: { list: [{ id: "main" }] } },
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
    const files = { "/config/base.json": { a: 1, b: 2 } };
    const obj = { $include: "./base.json", c: 3 };
    expect(resolve(obj, files)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("sibling keys override included values", () => {
    const files = { "/config/base.json": { a: 1, b: 2 } };
    const obj = { $include: "./base.json", b: 99 };
    expect(resolve(obj, files)).toEqual({ a: 1, b: 99 });
  });

  it("throws when sibling keys are used with non-object includes", () => {
    const files = { "/config/list.json": ["a", "b"] };
    const obj = { $include: "./list.json", extra: true };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(
      /Sibling keys require included content to be an object/,
    );
  });

  it("resolves nested includes", () => {
    const files = {
      "/config/level1.json": { nested: { $include: "./level2.json" } },
      "/config/level2.json": { deep: "value" },
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
    expect(() =>
      resolveConfigIncludes(obj, "/config/clawdbot.json", resolver),
    ).toThrow(ConfigIncludeError);
    expect(() =>
      resolveConfigIncludes(obj, "/config/clawdbot.json", resolver),
    ).toThrow(/Failed to parse include file/);
  });

  it("throws CircularIncludeError for circular includes", () => {
    const resolver: IncludeResolver = {
      readFile: (filePath: string) => {
        if (filePath === "/config/a.json") {
          return JSON.stringify({ $include: "./b.json" });
        }
        if (filePath === "/config/b.json") {
          return JSON.stringify({ $include: "./a.json" });
        }
        throw new Error(`Unknown file: ${filePath}`);
      },
      parseJson: JSON.parse,
    };
    const obj = { $include: "./a.json" };
    expect(() =>
      resolveConfigIncludes(obj, "/config/clawdbot.json", resolver),
    ).toThrow(CircularIncludeError);
    expect(() =>
      resolveConfigIncludes(obj, "/config/clawdbot.json", resolver),
    ).toThrow(/Circular include detected/);
  });

  it("throws ConfigIncludeError for invalid $include value type", () => {
    const obj = { $include: 123 };
    expect(() => resolve(obj)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj)).toThrow(/expected string or array/);
  });

  it("throws ConfigIncludeError for invalid array item type", () => {
    const files = { "/config/valid.json": { valid: true } };
    const obj = { $include: ["./valid.json", 123] };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(/expected string, got number/);
  });

  it("respects max depth limit", () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) {
      files[`/config/level${i}.json`] = { $include: `./level${i + 1}.json` };
    }
    files["/config/level15.json"] = { done: true };

    const obj = { $include: "./level0.json" };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(/Maximum include depth/);
  });

  it("handles relative paths correctly", () => {
    const files = { "/config/clients/mueller/agents.json": { id: "mueller" } };
    const obj = { agent: { $include: "./clients/mueller/agents.json" } };
    expect(resolve(obj, files)).toEqual({
      agent: { id: "mueller" },
    });
  });

  it("resolves parent directory references", () => {
    const files = { "/shared/common.json": { shared: true } };
    const obj = { $include: "../../shared/common.json" };
    expect(resolve(obj, files, "/config/sub/clawdbot.json")).toEqual({
      shared: true,
    });
  });
});

describe("real-world config patterns", () => {
  it("supports per-client agent includes", () => {
    const files = {
      "/config/clients/mueller.json": {
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
      "/config/clients/schmidt.json": {
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
      "/config/gateway.json": { gateway: { port: 18789, bind: "loopback" } },
      "/config/providers/whatsapp.json": {
        whatsapp: { dmPolicy: "pairing", allowFrom: ["+49123"] },
      },
      "/config/agents/defaults.json": {
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
    };

    const obj = {
      $include: [
        "./gateway.json",
        "./providers/whatsapp.json",
        "./agents/defaults.json",
      ],
    };

    expect(resolve(obj, files)).toEqual({
      gateway: { port: 18789, bind: "loopback" },
      whatsapp: { dmPolicy: "pairing", allowFrom: ["+49123"] },
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
  });
});

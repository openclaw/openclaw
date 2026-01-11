import { describe, expect, it } from "vitest";

import {
  CircularIncludeError,
  ConfigIncludeError,
  resolveIncludes,
} from "./io.js";

function createMockContext(
  files: Record<string, unknown>,
  basePath = "/config/clawdbot.json",
) {
  const fsModule = {
    readFileSync: (filePath: string) => {
      if (filePath in files) {
        return JSON.stringify(files[filePath]);
      }
      const err = new Error(`ENOENT: no such file: ${filePath}`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    },
  } as typeof import("node:fs");

  const json5Module = {
    parse: JSON.parse,
  } as typeof import("json5");

  return {
    basePath,
    visited: new Set([basePath]),
    depth: 0,
    fsModule,
    json5Module,
    logger: { error: () => {}, warn: () => {} },
  };
}

describe("resolveIncludes", () => {
  it("passes through primitives unchanged", () => {
    const ctx = createMockContext({});
    expect(resolveIncludes("hello", ctx)).toBe("hello");
    expect(resolveIncludes(42, ctx)).toBe(42);
    expect(resolveIncludes(true, ctx)).toBe(true);
    expect(resolveIncludes(null, ctx)).toBe(null);
  });

  it("passes through arrays with recursion", () => {
    const ctx = createMockContext({});
    expect(resolveIncludes([1, 2, { a: 1 }], ctx)).toEqual([1, 2, { a: 1 }]);
  });

  it("passes through objects without $include", () => {
    const ctx = createMockContext({});
    const obj = { foo: "bar", nested: { x: 1 } };
    expect(resolveIncludes(obj, ctx)).toEqual(obj);
  });

  it("resolves single file $include", () => {
    const ctx = createMockContext({
      "/config/agents.json": { list: [{ id: "main" }] },
    });
    const obj = { agents: { $include: "./agents.json" } };
    expect(resolveIncludes(obj, ctx)).toEqual({
      agents: { list: [{ id: "main" }] },
    });
  });

  it("resolves absolute path $include", () => {
    const ctx = createMockContext({
      "/etc/clawdbot/agents.json": { list: [{ id: "main" }] },
    });
    const obj = { agents: { $include: "/etc/clawdbot/agents.json" } };
    expect(resolveIncludes(obj, ctx)).toEqual({
      agents: { list: [{ id: "main" }] },
    });
  });

  it("resolves array $include with deep merge", () => {
    const ctx = createMockContext({
      "/config/a.json": { "group-a": ["agent1"] },
      "/config/b.json": { "group-b": ["agent2"] },
    });
    const obj = { broadcast: { $include: ["./a.json", "./b.json"] } };
    expect(resolveIncludes(obj, ctx)).toEqual({
      broadcast: {
        "group-a": ["agent1"],
        "group-b": ["agent2"],
      },
    });
  });

  it("deep merges overlapping keys in array $include", () => {
    const ctx = createMockContext({
      "/config/a.json": { agents: { defaults: { workspace: "~/a" } } },
      "/config/b.json": { agents: { list: [{ id: "main" }] } },
    });
    const obj = { $include: ["./a.json", "./b.json"] };
    expect(resolveIncludes(obj, ctx)).toEqual({
      agents: {
        defaults: { workspace: "~/a" },
        list: [{ id: "main" }],
      },
    });
  });

  it("merges $include with sibling keys", () => {
    const ctx = createMockContext({
      "/config/base.json": { a: 1, b: 2 },
    });
    const obj = { $include: "./base.json", c: 3 };
    expect(resolveIncludes(obj, ctx)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("sibling keys override included values", () => {
    const ctx = createMockContext({
      "/config/base.json": { a: 1, b: 2 },
    });
    const obj = { $include: "./base.json", b: 99 };
    expect(resolveIncludes(obj, ctx)).toEqual({ a: 1, b: 99 });
  });

  it("resolves nested includes", () => {
    const ctx = createMockContext({
      "/config/level1.json": { nested: { $include: "./level2.json" } },
      "/config/level2.json": { deep: "value" },
    });
    const obj = { $include: "./level1.json" };
    expect(resolveIncludes(obj, ctx)).toEqual({
      nested: { deep: "value" },
    });
  });

  it("throws ConfigIncludeError for missing file", () => {
    const ctx = createMockContext({});
    const obj = { $include: "./missing.json" };
    expect(() => resolveIncludes(obj, ctx)).toThrow(ConfigIncludeError);
    expect(() => resolveIncludes(obj, ctx)).toThrow(/Failed to read include file/);
  });

  it("throws ConfigIncludeError for invalid JSON", () => {
    const fsModule = {
      readFileSync: () => "{ invalid json }",
    } as typeof import("node:fs");
    const json5Module = {
      parse: JSON.parse,
    } as typeof import("json5");
    const ctx = {
      basePath: "/config/clawdbot.json",
      visited: new Set(["/config/clawdbot.json"]),
      depth: 0,
      fsModule,
      json5Module,
      logger: { error: () => {}, warn: () => {} },
    };
    const obj = { $include: "./bad.json" };
    expect(() => resolveIncludes(obj, ctx)).toThrow(ConfigIncludeError);
    expect(() => resolveIncludes(obj, ctx)).toThrow(/Failed to parse include file/);
  });

  it("throws CircularIncludeError for circular includes", () => {
    // Create a mock that simulates circular includes
    const fsModule = {
      readFileSync: (filePath: string) => {
        if (filePath === "/config/a.json") {
          return JSON.stringify({ $include: "./b.json" });
        }
        if (filePath === "/config/b.json") {
          return JSON.stringify({ $include: "./a.json" });
        }
        throw new Error(`Unknown file: ${filePath}`);
      },
    } as typeof import("node:fs");
    const json5Module = { parse: JSON.parse } as typeof import("json5");
    const ctx = {
      basePath: "/config/clawdbot.json",
      visited: new Set(["/config/clawdbot.json"]),
      depth: 0,
      fsModule,
      json5Module,
      logger: { error: () => {}, warn: () => {} },
    };
    const obj = { $include: "./a.json" };
    expect(() => resolveIncludes(obj, ctx)).toThrow(CircularIncludeError);
    expect(() => resolveIncludes(obj, ctx)).toThrow(/Circular include detected/);
  });

  it("throws ConfigIncludeError for invalid $include value type", () => {
    const ctx = createMockContext({});
    const obj = { $include: 123 };
    expect(() => resolveIncludes(obj, ctx)).toThrow(ConfigIncludeError);
    expect(() => resolveIncludes(obj, ctx)).toThrow(/expected string or array/);
  });

  it("throws ConfigIncludeError for invalid array item type", () => {
    const ctx = createMockContext({
      "/config/valid.json": { valid: true },
    });
    const obj = { $include: ["./valid.json", 123] };
    expect(() => resolveIncludes(obj, ctx)).toThrow(ConfigIncludeError);
    expect(() => resolveIncludes(obj, ctx)).toThrow(/expected string, got number/);
  });

  it("respects max depth limit", () => {
    // Create deeply nested includes
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) {
      files[`/config/level${i}.json`] = { $include: `./level${i + 1}.json` };
    }
    files["/config/level15.json"] = { done: true };

    const ctx = createMockContext(files);
    const obj = { $include: "./level0.json" };
    expect(() => resolveIncludes(obj, ctx)).toThrow(ConfigIncludeError);
    expect(() => resolveIncludes(obj, ctx)).toThrow(/Maximum include depth/);
  });

  it("handles relative paths correctly", () => {
    const ctx = createMockContext(
      {
        "/config/clients/mueller/agents.json": { id: "mueller" },
      },
      "/config/clawdbot.json",
    );
    const obj = { agent: { $include: "./clients/mueller/agents.json" } };
    expect(resolveIncludes(obj, ctx)).toEqual({
      agent: { id: "mueller" },
    });
  });

  it("resolves parent directory references", () => {
    const ctx = createMockContext(
      {
        "/shared/common.json": { shared: true },
      },
      "/config/sub/clawdbot.json",
    );
    const obj = { $include: "../../shared/common.json" };
    expect(resolveIncludes(obj, ctx)).toEqual({ shared: true });
  });
});

describe("real-world config patterns", () => {
  it("supports per-client agent includes", () => {
    const ctx = createMockContext({
      "/config/clients/mueller.json": {
        agents: [
          { id: "mueller-screenshot", workspace: "~/clients/mueller/screenshot" },
          { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
        ],
        broadcast: { "group-mueller": ["mueller-screenshot", "mueller-transcribe"] },
      },
      "/config/clients/schmidt.json": {
        agents: [
          { id: "schmidt-screenshot", workspace: "~/clients/schmidt/screenshot" },
        ],
        broadcast: { "group-schmidt": ["schmidt-screenshot"] },
      },
    });

    const obj = {
      gateway: { port: 18789 },
      $include: ["./clients/mueller.json", "./clients/schmidt.json"],
    };

    expect(resolveIncludes(obj, ctx)).toEqual({
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
    const ctx = createMockContext({
      "/config/gateway.json": { gateway: { port: 18789, bind: "loopback" } },
      "/config/providers/whatsapp.json": {
        whatsapp: { dmPolicy: "pairing", allowFrom: ["+49123"] },
      },
      "/config/agents/defaults.json": {
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
    });

    const obj = {
      $include: [
        "./gateway.json",
        "./providers/whatsapp.json",
        "./agents/defaults.json",
      ],
    };

    expect(resolveIncludes(obj, ctx)).toEqual({
      gateway: { port: 18789, bind: "loopback" },
      whatsapp: { dmPolicy: "pairing", allowFrom: ["+49123"] },
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
  });
});

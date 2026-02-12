import path from "node:path";
import { describe, it, expect } from "vitest";
import type { IncludeResolver } from "./includes.js";
import { restoreIncludeDirectives, buildIncludeMap } from "./include-preserve.js";

function createMockResolver(files: Record<string, unknown>): IncludeResolver {
  // Normalise file paths so lookups work on both Unix and Windows.
  // On Windows, path.resolve("/config", "./base.json5") produces
  // "C:\config\base.json5", so we need to normalise the keys the same way.
  const normalised = new Map<string, unknown>();
  for (const [k, v] of Object.entries(files)) {
    normalised.set(path.resolve(k), v);
  }
  return {
    readFile: (filePath: string) => {
      const resolved = path.resolve(filePath);
      if (normalised.has(resolved)) {
        return JSON.stringify(normalised.get(resolved));
      }
      throw new Error(`ENOENT: no such file: ${filePath}`);
    },
    parseJson: JSON.parse,
  };
}

describe("restoreIncludeDirectives", () => {
  it("passes through config without $include unchanged", () => {
    const incoming = { gateway: { port: 18789 }, models: {} };
    const rawParsed = { gateway: { port: 18789 }, models: {} };
    const includeMap = new Map<string, unknown>();

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    expect(result).toEqual(incoming);
  });

  it("preserves top-level $include directive", () => {
    const incoming = {
      gateway: { port: 18789, bind: "loopback" },
      agents: [{ id: "main" }],
    };
    const rawParsed = {
      $include: "./base.json5",
      gateway: { port: 18789, bind: "loopback" },
    };
    const includeMap = new Map<string, unknown>([["./base.json5", { agents: [{ id: "main" }] }]]);

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    expect(result).toEqual({
      $include: "./base.json5",
      gateway: { port: 18789, bind: "loopback" },
    });
  });

  it("preserves array $include directive", () => {
    const incoming = {
      gateway: { port: 18789 },
      agents: [{ id: "main" }],
      channels: { telegram: {} },
    };
    const rawParsed = {
      $include: ["./agents.json5", "./channels.json5"],
      gateway: { port: 18789 },
    };
    const includeMap = new Map<string, unknown>([
      ["./agents.json5", { agents: [{ id: "main" }] }],
      ["./channels.json5", { channels: { telegram: {} } }],
    ]);

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    expect(result).toEqual({
      $include: ["./agents.json5", "./channels.json5"],
      gateway: { port: 18789 },
    });
  });

  it("does not inline keys from included files even when changed", () => {
    // When a key comes from an included file and the caller changes it,
    // we still don't inline it — the included file is the source of truth.
    // The caller should modify the included file directly.
    const incoming = {
      gateway: { port: 18789 },
      agents: [{ id: "main" }, { id: "new-agent" }], // changed from included value
    };
    const rawParsed = {
      $include: "./base.json5",
      gateway: { port: 18789 },
    };
    const includeMap = new Map<string, unknown>([["./base.json5", { agents: [{ id: "main" }] }]]);

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    // agents should NOT be inlined — it came from the include
    expect(result).toEqual({
      $include: "./base.json5",
      gateway: { port: 18789 },
    });
  });

  it("preserves nested $include directives", () => {
    const incoming = {
      gateway: { port: 18789 },
      agents: {
        defaults: { workspace: "~/agents" },
        list: [{ id: "main" }],
      },
    };
    const rawParsed = {
      gateway: { port: 18789 },
      agents: {
        $include: "./agents-config.json5",
        defaults: { workspace: "~/agents" },
      },
    };
    const includeMap = new Map<string, unknown>([
      ["./agents-config.json5", { list: [{ id: "main" }] }],
    ]);

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    expect(result).toEqual({
      gateway: { port: 18789 },
      agents: {
        $include: "./agents-config.json5",
        defaults: { workspace: "~/agents" },
      },
    });
  });

  it("adds new top-level keys as local overrides", () => {
    const incoming = {
      gateway: { port: 18789 },
      agents: [{ id: "main" }],
      newKey: "new-value", // caller added this
    };
    const rawParsed = {
      $include: "./base.json5",
      gateway: { port: 18789 },
    };
    const includeMap = new Map<string, unknown>([["./base.json5", { agents: [{ id: "main" }] }]]);

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    expect(result).toEqual({
      $include: "./base.json5",
      gateway: { port: 18789 },
      newKey: "new-value",
    });
  });

  it("handles non-object incoming gracefully", () => {
    expect(restoreIncludeDirectives("string", {}, new Map())).toBe("string");
    expect(restoreIncludeDirectives(42, {}, new Map())).toBe(42);
    expect(restoreIncludeDirectives(null, {}, new Map())).toBe(null);
  });

  it("handles non-object rawParsed gracefully", () => {
    const incoming = { gateway: {} };
    expect(restoreIncludeDirectives(incoming, null, new Map())).toEqual(incoming);
    expect(restoreIncludeDirectives(incoming, "string", new Map())).toEqual(incoming);
  });

  it("does not inline secrets from included files", () => {
    // Key scenario: included file has ${ENV_VAR} refs that resolved to real API keys
    // The includeMap should have env-resolved values (done by the caller in io.ts)
    const incoming = {
      gateway: { port: 18789 },
      models: {
        providers: {
          anthropic: { apiKey: "sk-ant-real-secret-key" },
        },
      },
    };
    const rawParsed = {
      $include: "./secrets.json5",
      gateway: { port: 18789 },
    };
    const includeMap = new Map<string, unknown>([
      [
        "./secrets.json5",
        {
          models: {
            providers: {
              anthropic: { apiKey: "sk-ant-real-secret-key" },
            },
          },
        },
      ],
    ]);

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    // The secret should NOT appear in the result
    expect(result).toEqual({
      $include: "./secrets.json5",
      gateway: { port: 18789 },
    });
    expect((result as Record<string, unknown>).models).toBeUndefined();
  });

  it("preserves sibling key changes in files with $include", () => {
    const incoming = {
      gateway: { port: 19000 }, // changed from 18789
      agents: [{ id: "main" }],
    };
    const rawParsed = {
      $include: "./base.json5",
      gateway: { port: 18789 },
    };
    const includeMap = new Map<string, unknown>([["./base.json5", { agents: [{ id: "main" }] }]]);

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    expect(result).toEqual({
      $include: "./base.json5",
      gateway: { port: 19000 }, // changed value preserved
    });
  });

  it("handles missing include file gracefully", () => {
    const incoming = { gateway: { port: 18789 }, agents: [] };
    const rawParsed = {
      $include: "./missing.json5",
      gateway: { port: 18789 },
    };
    // No entry in includeMap for missing file
    const includeMap = new Map<string, unknown>();

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    // Should still preserve the $include directive
    expect(result).toEqual({
      $include: "./missing.json5",
      gateway: { port: 18789 },
      agents: [],
    });
  });

  it("excludes nested keys from includes within sibling objects", () => {
    // Include provides gateway.auth.token, local config has gateway.port
    // The token should NOT be inlined into the main config
    const incoming = {
      gateway: {
        port: 18789,
        bind: "loopback",
        auth: { token: "super-secret" },
      },
    };
    const rawParsed = {
      $include: "./secrets.json5",
      gateway: { port: 18789, bind: "loopback" },
    };
    const includeMap = new Map<string, unknown>([
      ["./secrets.json5", { gateway: { auth: { token: "super-secret" } } }],
    ]);

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    expect(result).toEqual({
      $include: "./secrets.json5",
      gateway: { port: 18789, bind: "loopback" },
    });
    // auth.token must not be inlined
    expect((result as Record<string, Record<string, unknown>>).gateway.auth).toBeUndefined();
  });

  it("keeps genuinely new nested keys that are not from includes", () => {
    const incoming = {
      gateway: {
        port: 18789,
        bind: "loopback",
        auth: { token: "from-include" },
        newSetting: true, // genuinely new, not from include
      },
    };
    const rawParsed = {
      $include: "./secrets.json5",
      gateway: { port: 18789, bind: "loopback" },
    };
    const includeMap = new Map<string, unknown>([
      ["./secrets.json5", { gateway: { auth: { token: "from-include" } } }],
    ]);

    const result = restoreIncludeDirectives(incoming, rawParsed, includeMap);
    expect(result).toEqual({
      $include: "./secrets.json5",
      gateway: { port: 18789, bind: "loopback", newSetting: true },
    });
  });
});

describe("buildIncludeMap", () => {
  it("builds map for single include", () => {
    const files = {
      "/config/base.json5": { agents: [{ id: "main" }] },
    };
    const rawParsed = { $include: "./base.json5" };
    const resolver = createMockResolver(files);
    const map = buildIncludeMap(rawParsed, "/config/openclaw.json", resolver);

    expect(map.size).toBe(1);
    expect(map.get("./base.json5")).toEqual({ agents: [{ id: "main" }] });
  });

  it("builds map for array includes", () => {
    const files = {
      "/config/agents.json5": { agents: [] },
      "/config/channels.json5": { channels: {} },
    };
    const rawParsed = { $include: ["./agents.json5", "./channels.json5"] };
    const resolver = createMockResolver(files);
    const map = buildIncludeMap(rawParsed, "/config/openclaw.json", resolver);

    expect(map.size).toBe(2);
    expect(map.has("./agents.json5")).toBe(true);
    expect(map.has("./channels.json5")).toBe(true);
  });

  it("handles nested includes in raw config", () => {
    const files = {
      "/config/agents-config.json5": { list: [{ id: "main" }] },
    };
    const rawParsed = {
      gateway: {},
      agents: { $include: "./agents-config.json5" },
    };
    const resolver = createMockResolver(files);
    const map = buildIncludeMap(rawParsed, "/config/openclaw.json", resolver);

    expect(map.size).toBe(1);
    expect(map.get("./agents-config.json5")).toEqual({ list: [{ id: "main" }] });
  });

  it("handles missing include files gracefully", () => {
    const rawParsed = { $include: "./missing.json5" };
    const resolver = createMockResolver({});
    const map = buildIncludeMap(rawParsed, "/config/openclaw.json", resolver);

    expect(map.size).toBe(0);
  });

  it("handles config without includes", () => {
    const rawParsed = { gateway: { port: 18789 } };
    const resolver = createMockResolver({});
    const map = buildIncludeMap(rawParsed, "/config/openclaw.json", resolver);

    expect(map.size).toBe(0);
  });
});

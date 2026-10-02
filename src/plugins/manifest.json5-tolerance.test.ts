// Covers JSON5 tolerance in plugin manifest parsing.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemorySlotDecision } from "./config-state.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function writeManifest(content: unknown) {
  const dir = makeTrackedTempDir("openclaw-manifest-json5", tempDirs);
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf-8",
  );
  return dir;
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTrackedTempDirs(tempDirs);
});

describe("loadPluginManifest JSON5 tolerance", () => {
  it("normalizes static doctor session route-state owners", () => {
    const dir = writeManifest({
      id: "doctor-owners",
      configSchema: { type: "object" },
      sessionRouteStateOwners: [
        {
          id: " demo ",
          label: " Demo owner ",
          providerIds: [" demo ", "", "demo"],
        },
        { id: "blank-list", label: "Blank list", runtimeIds: [" "] },
        { id: " ", label: "Missing id" },
        null,
      ],
    });

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.sessionRouteStateOwners).toEqual([
        {
          id: "demo",
          label: "Demo owner",
          providerIds: ["demo", "demo"],
          runtimeIds: [],
          cliSessionKeys: [],
          authProfilePrefixes: [],
        },
      ]);
    }
  });

  it("uses native JSON parsing for standard JSON manifests", () => {
    const json5Parse = vi.spyOn(JSON5, "parse");
    const dir = writeManifest({
      id: "strict-json",
      configSchema: { type: "object" },
    });

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    expect(json5Parse).not.toHaveBeenCalled();
  });

  it("reuses unchanged manifest loads within one lifecycle generation", () => {
    const dir = writeManifest({
      id: "cached-json",
      configSchema: { type: "object" },
    });
    const first = loadPluginManifest(dir, false);
    const second = loadPluginManifest(dir, false);

    expect(first.ok).toBe(true);
    expect(second).toBe(first);
  });

  it("parses a manifest with trailing commas", () => {
    const dir = writeManifest(`{
  "id": "hindsight",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
    },
  },
}`);
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("hindsight");
    }
  });

  it.each([
    {
      name: "a supported memory kind",
      rawKind: "memory",
      expectedKind: "memory",
    },
    {
      name: "both supported kinds in declaration order",
      rawKind: ["context-engine", "memory"],
      expectedKind: ["context-engine", "memory"],
    },
    {
      name: "supported kinds filtered from invalid and duplicate array entries",
      rawKind: ["memory", "unknown-kind", 42, "memory", "context-engine", null],
      expectedKind: ["memory", "context-engine"],
    },
    {
      name: "an unsupported scalar kind",
      rawKind: "unknown-kind",
      expectedKind: undefined,
    },
    {
      name: "an array containing only unsupported kinds",
      rawKind: ["unknown-kind", 42, null],
      expectedKind: undefined,
    },
  ])("normalizes $name", ({ rawKind, expectedKind }) => {
    const dir = writeManifest({
      id: "kind-normalization",
      kind: rawKind,
      configSchema: { type: "object" },
    });

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toEqual(expectedKind);
    }
  });

  it("keeps duplicate memory declarations subject to the exclusive memory slot", () => {
    const dir = writeManifest({
      id: "duplicate-memory",
      kind: ["memory", "memory"],
      configSchema: { type: "object" },
    });

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("memory");
      expect(
        resolveMemorySlotDecision({
          id: result.manifest.id,
          kind: result.manifest.kind,
          slot: "memory-core",
          selectedId: "memory-core",
        }),
      ).toEqual({ enabled: false, reason: 'memory slot set to "memory-core"' });
    }
  });

  it("normalizes modelSupport metadata from the manifest", () => {
    const dir = writeManifest(`{
  id: "provider-plugin",
  modelSupport: {
    modelPrefixes: ["gpt-", "", "claude-"],
    modelPatterns: ["^o[0-9].*", ""],
  },
  configSchema: { type: "object" }
}`);
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.modelSupport).toEqual({
        modelPrefixes: ["gpt-", "claude-"],
        modelPatterns: ["^o[0-9].*"],
      });
    }
  });

  it("normalizes catalog curation metadata from the manifest", () => {
    const dir = writeManifest(`{
  id: "catalog-plugin",
  catalog: {
    featured: false,
    order: 0,
  },
  configSchema: { type: "object" }
}`);

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.catalog).toEqual({ featured: false, order: 0 });
    }
  });

  it("retains static MCP server declarations", () => {
    const dir = writeManifest({
      id: "mcp-app-plugin",
      configSchema: { type: "object" },
      mcpServers: {
        app: {
          transport: "stdio",
          command: "node",
          args: ["./mcp-server.js"],
        },
        invalid: "./not-a-server.json",
      },
    });

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.mcpServers).toEqual({
        app: {
          transport: "stdio",
          command: "node",
          args: ["./mcp-server.js"],
        },
      });
    }
  });

  it("normalizes activation and setup descriptor metadata from the manifest", () => {
    const dir = writeManifest(`{
  id: "openai",
  activation: {
    onStartup: false,
    onProviders: ["openai", "", "openai"],
    onCommands: ["models", ""],
    onChannels: ["web", ""],
    onRoutes: ["gateway-webhook", ""],
    onConfigPaths: ["browser", ""],
    onCapabilities: ["provider", "tool", "wat"]
  },
  cliCommands: [
    { name: "models", description: "Inspect provider models", hasSubcommands: true },
    { name: "bad command", description: "ignored", hasSubcommands: false },
    { name: "models", description: "duplicate", hasSubcommands: false }
  ],
  setup: {
    providers: [
      { id: "openai", authMethods: ["api-key", ""], envVars: ["OPENAI_API_KEY", ""] },
      { id: "", authMethods: ["oauth"] }
    ],
    cliBackends: ["openai-cli", ""],
    configMigrations: ["legacy-openai-auth", ""],
    requiresRuntime: false
  },
  configSchema: { type: "object" }
}`);
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.activation).toEqual({
        onStartup: false,
        onProviders: ["openai", "openai"],
        onCommands: ["models"],
        onChannels: ["web"],
        onRoutes: ["gateway-webhook"],
        onConfigPaths: ["browser"],
        onCapabilities: ["provider", "tool"],
      });
      expect(result.manifest.cliCommands).toEqual([
        {
          name: "models",
          description: "Inspect provider models",
          hasSubcommands: true,
        },
      ]);
      expect(result.manifest.setup).toEqual({
        providers: [
          {
            id: "openai",
            authMethods: ["api-key"],
            envVars: ["OPENAI_API_KEY"],
          },
        ],
        cliBackends: ["openai-cli"],
        configMigrations: ["legacy-openai-auth"],
        requiresRuntime: false,
      });
    }
  });

  it("still rejects completely invalid syntax", () => {
    const dir = writeManifest("not json at all {{{}}");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to parse plugin manifest");
    }
  });

  it("rejects JSON5 values that parse but are not objects", () => {
    const dir = writeManifest("'just a string'");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest must be an object");
    }
  });
});

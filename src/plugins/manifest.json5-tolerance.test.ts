import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemorySlotDecision } from "./config-state.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function parseManifest(content: Record<string, unknown> | string) {
  const dir = makeTrackedTempDir("openclaw-manifest-json5", tempDirs);
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    typeof content === "string"
      ? content
      : JSON.stringify({ id: "test-plugin", configSchema: { type: "object" }, ...content }),
    "utf-8",
  );
  const result = loadPluginManifest(dir, false);
  assert(result.ok);
  return result.manifest;
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
    const manifest = parseManifest({
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

    expect(manifest.sessionRouteStateOwners).toEqual([
      {
        id: "demo",
        label: "Demo owner",
        providerIds: ["demo", "demo"],
        runtimeIds: [],
        cliSessionKeys: [],
        authProfilePrefixes: [],
      },
    ]);
  });

  it.each([
    ["memory", "memory"],
    [
      ["context-engine", "memory"],
      ["context-engine", "memory"],
    ],
    [
      ["memory", "unknown-kind", 42, "memory", "context-engine", null],
      ["memory", "context-engine"],
    ],
    ["unknown-kind", undefined],
    [["unknown-kind", 42, null], undefined],
  ])("normalizes kind %j to %j", (kind, expected) => {
    expect(parseManifest({ kind }).kind).toEqual(expected);
  });

  it("keeps duplicate memory declarations subject to the exclusive memory slot", () => {
    const manifest = parseManifest({
      id: "duplicate-memory",
      kind: ["memory", "memory"],
    });

    expect(manifest.kind).toBe("memory");
    expect(
      resolveMemorySlotDecision({
        id: manifest.id,
        kind: manifest.kind,
        slot: "memory-core",
        selectedId: "memory-core",
      }),
    ).toEqual({ enabled: false, reason: 'memory slot set to "memory-core"' });
  });

  it("retains static MCP server declarations", () => {
    const server = { transport: "stdio", command: "node", args: ["./mcp-server.js"] };
    const manifest = parseManifest({
      mcpServers: {
        app: server,
        invalid: "./not-a-server.json",
      },
    });

    expect(manifest.mcpServers).toEqual({ app: server });
  });

  it("normalizes activation and setup descriptor metadata from the manifest", () => {
    const manifest = parseManifest(`{
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
    expect(manifest.activation).toEqual({
      onStartup: false,
      onProviders: ["openai", "openai"],
      onCommands: ["models"],
      onChannels: ["web"],
      onRoutes: ["gateway-webhook"],
      onConfigPaths: ["browser"],
      onCapabilities: ["provider", "tool"],
    });
    expect(manifest.cliCommands).toEqual([
      {
        name: "models",
        description: "Inspect provider models",
        hasSubcommands: true,
      },
    ]);
    expect(manifest.setup).toEqual({
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
  });
});

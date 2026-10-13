// Covers JSON5 tolerance in plugin manifest parsing.
import fs from "node:fs";
import path from "node:path";
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

  it("retains static MCP server declarations", () => {
    const dir = writeManifest({
      id: "mcp-app-plugin",
      configSchema: { type: "object" },
      mcpServers: {
        app: {
          transport: "stdio",
          command: "node",
          args: ["./mcp-server.js"],
          install: { kind: "uv", package: "example-mcp==1.2.3" },
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
          install: [{ kind: "uv", package: "example-mcp==1.2.3" }],
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
});

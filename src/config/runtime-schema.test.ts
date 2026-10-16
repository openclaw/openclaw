// Covers runtime schema defaults and generated runtime config behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRegistryVersion,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { ConfigJsonSchemaObject } from "./schema.shared.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import type { PluginEntryConfig } from "./types.plugins.js";

const mockLoadConfig = vi.hoisted(() => vi.fn<() => OpenClawConfig>());
const mockReadConfigFileSnapshot = vi.hoisted(() =>
  vi.fn<(options?: { observe?: boolean }) => Promise<ConfigFileSnapshot>>(),
);
const mockLoadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const mockGetCurrentPluginMetadataSnapshot = vi.hoisted(() => vi.fn());

let readBestEffortRuntimeConfigSchema: typeof import("./runtime-schema.js").readBestEffortRuntimeConfigSchema;
let loadGatewayRuntimeConfigSchema: typeof import("./runtime-schema.js").loadGatewayRuntimeConfigSchema;
let invalidateGatewayRuntimeConfigSchema: typeof import("./runtime-schema.js").invalidateGatewayRuntimeConfigSchema;

function explicitMainRoster(): OpenClawConfig {
  return { agents: { entries: { main: {} } } };
}
function pluginConfig(id: string, entry: PluginEntryConfig = { enabled: true }): OpenClawConfig {
  return { ...explicitMainRoster(), plugins: { entries: { [id]: entry } } };
}
function objectSchema(properties: Record<string, unknown>, additionalProperties = false) {
  return { type: "object", properties, additionalProperties };
}

vi.mock("./config.js", () => ({
  getRuntimeConfig: () => mockLoadConfig(),
  loadConfig: () => mockLoadConfig(),
  readConfigFileSnapshot: (...args: Parameters<typeof mockReadConfigFileSnapshot>) =>
    mockReadConfigFileSnapshot(...args),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: (...args: unknown[]) => mockLoadPluginManifestRegistry(...args),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: (...args: unknown[]) =>
    mockLoadPluginManifestRegistry(...args),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (...args: unknown[]) =>
    createPluginMetadataSnapshotFixture(mockLoadPluginManifestRegistry(...args)),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => {
    const current = mockGetCurrentPluginMetadataSnapshot(...args);
    return createPluginMetadataSnapshotFixture(
      current?.manifestRegistry ?? mockLoadPluginManifestRegistry(...args),
    );
  },
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: (...args: unknown[]) =>
    mockGetCurrentPluginMetadataSnapshot(...args),
}));

function makeSnapshot(valid: boolean, config: OpenClawConfig = {}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: config,
    resolved: config,
    sourceConfig: config,
    valid,
    config,
    runtimeConfig: config,
    issues: valid ? [] : [{ path: "gateway", message: "invalid" }],
    warnings: [],
    legacyIssues: [],
  };
}

function channelPlugin(id: string, origin: PluginOrigin, field?: string) {
  return {
    id,
    origin,
    channels: [id],
    ...(field
      ? {
          channelConfigs: {
            [id]: { schema: { type: "object", properties: { [field]: { type: "string" } } } },
          },
        }
      : {}),
  };
}
function makeManifestRegistry() {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "demo",
        origin: "bundled",
        channels: [],
        configSchema: { type: "object", properties: { mode: { type: "string" } } },
      },
      channelPlugin("telegram", "bundled", "botToken"),
      channelPlugin("slack", "bundled", "botToken"),
      channelPlugin("matrix", "workspace", "homeserver"),
    ],
  };
}

const heartbeatVisibility = {
  type: "object",
  properties: {
    showOk: { type: "boolean" },
    showAlerts: { type: "boolean" },
    useIndicator: { type: "boolean" },
  },
  additionalProperties: false,
};
function externalChannel(schema: Record<string, unknown>) {
  const plugin = {
    ...channelPlugin("external-chat", "workspace"),
    channelConfigs: { "external-chat": { schema } },
  };
  return { diagnostics: [], plugins: [plugin] };
}
function channelProperties(result: Awaited<ReturnType<typeof readBestEffortRuntimeConfigSchema>>) {
  const schema: ConfigJsonSchemaObject = result.schema;
  return schema.properties?.channels?.properties;
}

async function readSchemaNodes(prepared?: Parameters<typeof readBestEffortRuntimeConfigSchema>[0]) {
  const result = await readBestEffortRuntimeConfigSchema(prepared);
  const schema: ConfigJsonSchemaObject = result.schema;
  return {
    channelProps: channelProperties(result),
    entryProps: schema.properties?.plugins?.properties?.entries?.properties,
  };
}

function firstArg(mock: { mock: { calls: unknown[][] } }): unknown {
  return mock.mock.calls[0]?.[0];
}

beforeAll(async () => {
  ({
    readBestEffortRuntimeConfigSchema,
    loadGatewayRuntimeConfigSchema,
    invalidateGatewayRuntimeConfigSchema,
  } = await import("./runtime-schema.js"));
});

afterEach(() => resetPluginRuntimeStateForTest());

describe("readBestEffortRuntimeConfigSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadConfigFileSnapshot.mockReset();
    mockLoadConfig.mockReturnValue(explicitMainRoster());
    mockLoadPluginManifestRegistry.mockReturnValue(makeManifestRegistry());
  });

  it("builds from prepared config and metadata without another config or registry read", async () => {
    mockReadConfigFileSnapshot.mockResolvedValue(makeSnapshot(true, pluginConfig("fallback-only")));
    const snapshot = makeSnapshot(true, pluginConfig("prepared-demo"));
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "prepared-demo",
          configSchema: { type: "object", properties: { mode: { type: "string" } } },
          configUiHints: { mode: { sensitive: true } },
        },
      ],
    });

    const result = await readBestEffortRuntimeConfigSchema({ snapshot, pluginMetadataSnapshot });
    expect(result.schema).toHaveProperty(
      "properties.plugins.properties.entries.properties.prepared-demo.properties.config.properties.mode",
      expect.objectContaining({ type: "string" }),
    );
    expect(result.uiHints["plugins.entries.prepared-demo.config.mode"]?.sensitive).toBe(true);
    expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mockLoadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(mockGetCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("resolves missing metadata from the prepared config without rereading its source", async () => {
    mockReadConfigFileSnapshot.mockResolvedValue(
      makeSnapshot(true, {
        ...explicitMainRoster(),
        gateway: { mode: "local" },
      }),
    );
    const config = pluginConfig("prepared-only");

    const { channelProps, entryProps } = await readSchemaNodes({
      snapshot: makeSnapshot(true, config),
    });

    expect(channelProps).toHaveProperty("matrix");
    expect(entryProps).toHaveProperty("demo");
    expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    expect(firstArg(mockLoadPluginManifestRegistry)).toHaveProperty("config", config);
  });

  it("falls back to bundled channel metadata when config is invalid", async () => {
    mockReadConfigFileSnapshot.mockResolvedValueOnce(makeSnapshot(false));

    const { channelProps, entryProps } = await readSchemaNodes();

    expect(mockReadConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    const loadArg = firstArg(mockLoadPluginManifestRegistry);
    expect(loadArg).toHaveProperty("config", {
      ...explicitMainRoster(),
      plugins: { enabled: true },
    });
    expect(loadArg).not.toHaveProperty("cache", false);
    expect(loadArg).not.toHaveProperty("bundledChannelConfigCollector");
    expect(channelProps).toHaveProperty("telegram");
    expect(channelProps).toHaveProperty("slack");
    expect(entryProps?.demo).toBeUndefined();
  });
});

describe("loadGatewayRuntimeConfigSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(pluginConfig("demo"));
    mockLoadPluginManifestRegistry.mockReturnValue(makeManifestRegistry());
  });

  it.each(["config", "plugin registry", "invalidation"] as const)(
    "refreshes shared schema metadata after %s changes",
    (change) => {
      let config = explicitMainRoster();
      loadGatewayRuntimeConfigSchema(config);
      loadGatewayRuntimeConfigSchema(config);
      expect(mockLoadPluginManifestRegistry).toHaveBeenCalledTimes(1);

      setGatewayPluginMetadataSnapshot(
        createPluginMetadataSnapshotFixture({
          plugins: [{ id: "updated-plugin", configSchema: { type: "object" } }],
        }),
      );

      if (change === "config") {
        config = { ...config, plugins: { entries: { demo: { enabled: false } } } };
      } else if (change === "plugin registry") {
        setActivePluginRegistry(createEmptyPluginRegistry());
      } else {
        invalidateGatewayRuntimeConfigSchema();
      }

      expect(loadGatewayRuntimeConfigSchema(config).schema).toHaveProperty(
        "properties.plugins.properties.entries.properties.updated-plugin",
      );
      expect(mockLoadConfig).not.toHaveBeenCalled();
    },
  );

  it("does not execute plugin setup probes while selecting channel schemas", async () => {
    const setupRegistry = await import("../plugins/setup-registry.js");
    const probes = vi
      .spyOn(setupRegistry, "resolvePluginSetupAutoEnableReasons")
      .mockReturnValue([]);
    mockLoadConfig.mockReturnValue(
      pluginConfig("demo", { enabled: true, config: { mode: "synthetic" } }),
    );
    try {
      loadGatewayRuntimeConfigSchema();
      expect(probes).not.toHaveBeenCalled();
    } finally {
      probes.mockRestore();
    }
  });

  type OwnerCase = {
    name: string;
    entries: Record<string, PluginEntryConfig>;
    allow?: string[];
    deny: string[];
    expected: "plus" | "core" | "first";
    coreOrigin?: PluginOrigin;
    plusOrigin?: PluginOrigin;
  };
  function ownerCase(
    name: string,
    expected: OwnerCase["expected"],
    overrides: Partial<OwnerCase> = {},
  ): OwnerCase {
    return {
      name,
      expected,
      entries: { plus: { enabled: true }, core: { enabled: true } },
      deny: [],
      ...overrides,
    };
  }
  const ownerCases = [
    ownerCase("preferred owner", "plus", { entries: { plus: { enabled: true } } }),
    ownerCase("disabled replacement", "core", {
      entries: { plus: { enabled: false }, core: { enabled: true } },
    }),
    ownerCase("denied replacement", "core", { deny: ["plus"] }),
    ownerCase("explicit dual selection", "first"),
    ownerCase("explicit dual selection after allowlist materialization", "first", {
      allow: ["core"],
    }),
    ownerCase("untrusted material config", "core", {
      entries: { plus: { config: {} }, core: { enabled: true } },
      allow: ["core"],
    }),
    ownerCase("closer-origin owner", "plus", { coreOrigin: "workspace" }),
    ownerCase("ineligible workspace replacement", "core", {
      entries: { core: { enabled: true } },
      plusOrigin: "workspace",
    }),
  ];
  it.each(
    ownerCases.flatMap((scenario) =>
      (["plus", "core"] as const).map((first) => ({ scenario, first })),
    ),
  )(
    "publishes the $scenario.name schema and sensitive hints with $first first",
    ({
      scenario: { entries, allow, deny, expected, coreOrigin = "config", plusOrigin = "config" },
      first,
    }) => {
      mockLoadConfig.mockReturnValue({
        ...explicitMainRoster(),
        plugins: { entries, allow, deny },
        channels: { proofchat: { address: "local" } },
      });
      const order = first === "plus" ? ["plus", "core"] : ["core", "plus"];
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: order.map((id) => ({
          id,
          origin: id === "core" ? coreOrigin : plusOrigin,
          channels: ["proofchat"],
          providers: [],
          cliBackends: [],
          channelConfigs: {
            proofchat: {
              label: id,
              ...(id === "plus" ? { preferOver: ["core"] } : {}),
              schema: objectSchema({ [id]: { type: "string" } }),
              uiHints: { [id]: { sensitive: true } },
            },
          },
        })),
      });
      const owner = expected === "first" ? first : expected;
      const result = loadGatewayRuntimeConfigSchema();
      expect(result.uiHints["channels.proofchat"]).toMatchObject({ label: owner });
      expect(result.uiHints[`channels.proofchat.${owner}`]?.sensitive).toBe(true);
      expect(result.schema).toHaveProperty(
        `properties.channels.properties.proofchat.properties.${owner}`,
        expect.objectContaining({ type: "string" }),
      );
    },
  );

  it("projects strict heartbeat visibility for external channels and their accounts", () => {
    const endpoint = { endpoint: { type: "string" } };
    mockLoadPluginManifestRegistry.mockReturnValue(
      externalChannel(
        objectSchema({
          ...endpoint,
          accounts: { type: "object", additionalProperties: objectSchema(endpoint) },
        }),
      ),
    );

    const result = loadGatewayRuntimeConfigSchema();
    expect(channelProperties(result)?.["external-chat"]).toMatchObject({
      additionalProperties: false,
      properties: {
        heartbeatVisibility,
        accounts: {
          additionalProperties: {
            additionalProperties: false,
            properties: { heartbeatVisibility },
          },
        },
      },
    });
  });

  it("projects canonical heartbeats into composed schemas and referenced open accounts", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(
      externalChannel({
        $defs: { Account: {} },
        anyOf: [
          { type: "object", additionalProperties: true },
          objectSchema({
            accounts: { type: "object", additionalProperties: { $ref: "#/$defs/Account" } },
          }),
        ],
      }),
    );

    const result = loadGatewayRuntimeConfigSchema();
    const projected = channelProperties(result)?.["external-chat"];
    expect(projected).toMatchObject({
      properties: { heartbeatVisibility },
      anyOf: [
        { additionalProperties: true, properties: { heartbeatVisibility } },
        {
          additionalProperties: false,
          properties: {
            heartbeatVisibility,
            accounts: {
              additionalProperties: { properties: { heartbeatVisibility } },
            },
          },
        },
      ],
    });
    expect(projected?.$defs).toEqual({ Account: {} });
  });

  it("reuses the current gateway plugin metadata snapshot for config schema requests", () => {
    mockGetCurrentPluginMetadataSnapshot.mockReturnValueOnce({
      manifestRegistry: {
        diagnostics: [],
        plugins: [
          channelPlugin("telegram", "bundled"),
          channelPlugin("matrix", "workspace", "homeserver"),
        ],
      },
    });

    const result = loadGatewayRuntimeConfigSchema();
    const channelProps = channelProperties(result);

    expect(mockGetCurrentPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
    expect(firstArg(mockGetCurrentPluginMetadataSnapshot)).toHaveProperty(
      "config",
      pluginConfig("demo"),
    );
    expect(mockLoadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(channelProps).toHaveProperty("telegram");
    expect(JSON.stringify(channelProps?.telegram)).toContain("botToken");
    expect(channelProps).toHaveProperty("matrix");
  });

  it("does not activate or replace the active plugin registry across repeated schema loads (regression guard for #54816)", () => {
    // MCP schema reads must not rerun registerFull or replace the startup registry (#54816).
    const activeRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(activeRegistry, "startup-registry");
    const versionBefore = getActivePluginRegistryVersion();

    loadGatewayRuntimeConfigSchema();
    loadGatewayRuntimeConfigSchema();
    loadGatewayRuntimeConfigSchema();

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    for (const call of mockLoadPluginManifestRegistry.mock.calls) {
      expect(call[0]).toHaveProperty("config");
      expect(call[0]).not.toHaveProperty("bundledChannelConfigCollector");
    }
    expect(getActivePluginRegistry()).toBe(activeRegistry);
    expect(getActivePluginRegistryKey()).toBe("startup-registry");
    expect(getActivePluginRegistryVersion()).toBe(versionBefore);
  });
});

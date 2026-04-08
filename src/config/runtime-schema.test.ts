import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const mockLoadConfig = vi.hoisted(() => vi.fn<() => OpenClawConfig>());
const mockReadConfigFileSnapshot = vi.hoisted(() => vi.fn<() => Promise<ConfigFileSnapshot>>());
const mockLoadPluginManifestRegistry = vi.hoisted(() => vi.fn());

let readBestEffortRuntimeConfigSchema: typeof import("./runtime-schema.js").readBestEffortRuntimeConfigSchema;
let loadGatewayRuntimeConfigSchema: typeof import("./runtime-schema.js").loadGatewayRuntimeConfigSchema;

vi.mock("./config.js", () => {
  return {
    loadConfig: () => mockLoadConfig(),
    readConfigFileSnapshot: () => mockReadConfigFileSnapshot(),
  };
});

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => mockLoadPluginManifestRegistry(...args),
}));

function makeSnapshot(params: { valid: boolean; config?: OpenClawConfig }): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: params.config ?? {},
    resolved: params.config ?? {},
    sourceConfig: params.config ?? {},
    valid: params.valid,
    config: params.config ?? {},
    runtimeConfig: params.config ?? {},
    issues: params.valid ? [] : [{ path: "gateway", message: "invalid" }],
    warnings: [],
    legacyIssues: [],
  };
}

function makeManifestRegistry() {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "demo",
        name: "Demo",
        description: "Demo plugin",
        origin: "bundled",
        channels: [],
        configUiHints: {},
        configSchema: {
          type: "object",
          properties: {
            mode: { type: "string" },
          },
        },
      },
      {
        id: "telegram",
        name: "Telegram",
        description: "Telegram plugin",
        origin: "bundled",
        channels: ["telegram"],
        channelCatalogMeta: {
          id: "telegram",
          label: "Telegram",
          blurb: "Telegram channel",
        },
        channelConfigs: {
          telegram: {
            schema: {
              type: "object",
              properties: {
                botToken: { type: "string" },
              },
            },
            uiHints: {},
          },
        },
      },
      {
        id: "slack",
        name: "Slack",
        description: "Slack plugin",
        origin: "bundled",
        channels: ["slack"],
        channelCatalogMeta: {
          id: "slack",
          label: "Slack",
          blurb: "Slack channel",
        },
        channelConfigs: {
          slack: {
            schema: {
              type: "object",
              properties: {
                botToken: { type: "string" },
              },
            },
            uiHints: {},
          },
        },
      },
      {
        id: "matrix",
        name: "Matrix",
        description: "Matrix plugin",
        origin: "workspace",
        channels: ["matrix"],
        channelCatalogMeta: {
          id: "matrix",
          label: "Matrix",
          blurb: "Matrix channel",
        },
        channelConfigs: {
          matrix: {
            schema: {
              type: "object",
              properties: {
                homeserver: { type: "string" },
              },
            },
            uiHints: {},
          },
        },
      },
    ],
  };
}

async function readSchemaNodes() {
  const result = await readBestEffortRuntimeConfigSchema();
  const schema = result.schema as { properties?: Record<string, unknown> };
  const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
  const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;
  const pluginsNode = schema.properties?.plugins as Record<string, unknown> | undefined;
  const pluginProps = pluginsNode?.properties as Record<string, unknown> | undefined;
  const entriesNode = pluginProps?.entries as Record<string, unknown> | undefined;
  const entryProps = entriesNode?.properties as Record<string, unknown> | undefined;
  return { channelProps, entryProps };
}

beforeAll(async () => {
  ({ readBestEffortRuntimeConfigSchema, loadGatewayRuntimeConfigSchema } =
    await import("./runtime-schema.js"));
});

describe("readBestEffortRuntimeConfigSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({});
    mockLoadPluginManifestRegistry.mockReturnValue(makeManifestRegistry());
  });

  it("merges manifest plugin metadata for valid configs", async () => {
    mockReadConfigFileSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        valid: true,
        config: { plugins: { entries: { demo: { enabled: true } } } },
      }),
    );

    const { channelProps, entryProps } = await readSchemaNodes();

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { plugins: { entries: { demo: { enabled: true } } } },
        cache: false,
      }),
    );
    expect(channelProps?.telegram).toBeTruthy();
    expect(channelProps?.matrix).toBeTruthy();
    expect(entryProps?.demo).toBeTruthy();
  });

  it("falls back to bundled channel metadata when config is invalid", async () => {
    mockReadConfigFileSnapshot.mockResolvedValueOnce(makeSnapshot({ valid: false }));

    const { channelProps, entryProps } = await readSchemaNodes();

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { plugins: { enabled: true } },
        cache: false,
      }),
    );
    expect(channelProps?.telegram).toBeTruthy();
    expect(channelProps?.slack).toBeTruthy();
    expect(entryProps?.demo).toBeUndefined();
  });
});

describe("loadGatewayRuntimeConfigSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ plugins: { entries: { demo: { enabled: true } } } });
    mockLoadPluginManifestRegistry.mockReturnValue(makeManifestRegistry());
  });

  it("uses manifest metadata instead of booting plugin runtime", async () => {
    const result = loadGatewayRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { plugins: { entries: { demo: { enabled: true } } } },
        cache: false,
      }),
    );
    expect(channelProps?.telegram).toBeTruthy();
    expect(channelProps?.matrix).toBeTruthy();
  });
});

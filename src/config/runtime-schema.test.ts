import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const mockLoadConfig = vi.hoisted(() => vi.fn<() => OpenClawConfig>());
const mockReadConfigFileSnapshot = vi.hoisted(() => vi.fn<() => Promise<ConfigFileSnapshot>>());
const mockLoadOpenClawPlugins = vi.hoisted(() => vi.fn());
const mockListChannelPlugins = vi.hoisted(() => vi.fn());

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    loadConfig: () => mockLoadConfig(),
    readConfigFileSnapshot: () => mockReadConfigFileSnapshot(),
  };
});

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => mockLoadOpenClawPlugins(...args),
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: (...args: unknown[]) => mockListChannelPlugins(...args),
}));

function makeSnapshot(params: { valid: boolean; config?: OpenClawConfig }): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: params.config ?? {},
    resolved: params.config ?? {},
    valid: params.valid,
    config: params.config ?? {},
    issues: params.valid ? [] : [{ path: "gateway", message: "invalid" }],
    warnings: [],
    legacyIssues: [],
  };
}

async function readSchemaNodes() {
  const { readBestEffortRuntimeConfigSchema } = await import("./runtime-schema.js");
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

describe("readBestEffortRuntimeConfigSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({});
    mockListChannelPlugins.mockReturnValue([]);
  });

  it("uses scoped plugin registry channels for valid configs", async () => {
    mockReadConfigFileSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        valid: true,
        config: { plugins: { entries: { demo: { enabled: true } } } },
      }),
    );
    mockLoadOpenClawPlugins.mockReturnValueOnce({
      plugins: [
        {
          id: "demo",
          name: "Demo",
          description: "Demo plugin",
          configUiHints: {},
          configJsonSchema: {
            type: "object",
            properties: {
              mode: { type: "string" },
            },
          },
        },
      ],
      channels: [
        {
          pluginId: "telegram",
          pluginName: "Telegram",
          source: "bundled",
          plugin: {
            id: "telegram",
            meta: { label: "Telegram", blurb: "Telegram channel" },
            configSchema: {
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
      ],
      channelSetups: [],
    });

    const { channelProps, entryProps } = await readSchemaNodes();

    expect(mockLoadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { plugins: { entries: { demo: { enabled: true } } } },
        activate: false,
        cache: false,
      }),
    );
    expect(channelProps?.telegram).toBeTruthy();
    expect(entryProps?.demo).toBeTruthy();
  });

  it("falls back to channel-only schema when config is invalid", async () => {
    mockReadConfigFileSnapshot.mockResolvedValueOnce(makeSnapshot({ valid: false }));
    mockLoadOpenClawPlugins.mockReturnValueOnce({
      plugins: [],
      channels: [
        {
          pluginId: "slack",
          pluginName: "Slack",
          source: "bundled",
          plugin: {
            id: "slack",
            meta: { label: "Slack", blurb: "Slack channel" },
            configSchema: {
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
      ],
      channelSetups: [
        {
          pluginId: "telegram",
          pluginName: "Telegram",
          source: "bundled",
          plugin: {
            id: "telegram",
            meta: { label: "Telegram", blurb: "Telegram channel" },
            configSchema: {
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
      ],
    });

    const { channelProps, entryProps } = await readSchemaNodes();

    expect(mockLoadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { plugins: { enabled: true } },
        activate: false,
        cache: false,
        includeSetupOnlyChannelPlugins: true,
      }),
    );
    expect(channelProps?.telegram).toBeTruthy();
    expect(channelProps?.slack).toBeTruthy();
    expect(entryProps?.demo).toBeUndefined();
  });

  it("does not fall back to active registry channels when invalid fallback load throws", async () => {
    mockReadConfigFileSnapshot.mockResolvedValueOnce(makeSnapshot({ valid: false }));
    mockLoadOpenClawPlugins.mockImplementationOnce(() => {
      throw new Error("plugin load failed");
    });
    mockListChannelPlugins.mockReturnValueOnce([
      {
        id: "telegram",
        meta: { label: "Telegram", blurb: "Telegram channel" },
        configSchema: {
          schema: {
            type: "object",
            properties: {
              botToken: { type: "string" },
            },
          },
          uiHints: {},
        },
      },
    ]);

    const { readBestEffortRuntimeConfigSchema } = await import("./runtime-schema.js");
    const result = await readBestEffortRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;

    expect(channelProps?.telegram).toBeUndefined();
  });
});

describe("loadGatewayRuntimeConfigSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ plugins: { entries: { demo: { enabled: true } } } });
  });

  it("preserves gateway channel source and loader options", async () => {
    mockLoadOpenClawPlugins.mockReturnValueOnce({
      plugins: [
        {
          id: "demo",
          name: "Demo",
          description: "Demo plugin",
          configUiHints: {},
          configJsonSchema: {
            type: "object",
            properties: {
              mode: { type: "string" },
            },
          },
        },
      ],
      channels: [
        {
          pluginId: "scoped-only",
          pluginName: "Scoped Only",
          source: "bundled",
          plugin: {
            id: "scoped-only",
            meta: { label: "Scoped Only" },
          },
        },
      ],
      channelSetups: [],
    });
    mockListChannelPlugins.mockReturnValueOnce([
      {
        id: "telegram",
        meta: { label: "Telegram", blurb: "Telegram channel" },
        configSchema: {
          schema: {
            type: "object",
            properties: {
              botToken: { type: "string" },
            },
          },
          uiHints: {},
        },
      },
    ]);

    const { loadGatewayRuntimeConfigSchema } = await import("./runtime-schema.js");
    const result = loadGatewayRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;

    expect(mockLoadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { plugins: { entries: { demo: { enabled: true } } } },
        cache: true,
      }),
    );
    expect(mockLoadOpenClawPlugins.mock.calls[0]?.[0]?.activate).toBeUndefined();
    expect(channelProps?.telegram).toBeTruthy();
    expect(channelProps?.["scoped-only"]).toBeUndefined();
  });
});

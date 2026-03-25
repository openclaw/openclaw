import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const mockReadConfigFileSnapshot = vi.hoisted(() => vi.fn<() => Promise<ConfigFileSnapshot>>());
const mockLoadOpenClawPlugins = vi.hoisted(() => vi.fn());
const mockListChannelPlugins = vi.hoisted(() => vi.fn());

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
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

describe("readBestEffortRuntimeConfigSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListChannelPlugins.mockReturnValue([
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
  });

  it("uses non-activating plugin loads for valid configs", async () => {
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
    });

    const { readBestEffortRuntimeConfigSchema } = await import("./runtime-schema.js");
    const result = await readBestEffortRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;
    const pluginsNode = schema.properties?.plugins as Record<string, unknown> | undefined;
    const pluginProps = pluginsNode?.properties as Record<string, unknown> | undefined;
    const entriesNode = pluginProps?.entries as Record<string, unknown> | undefined;
    const entryProps = entriesNode?.properties as Record<string, unknown> | undefined;

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

    const { readBestEffortRuntimeConfigSchema } = await import("./runtime-schema.js");
    const result = await readBestEffortRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;
    const pluginsNode = schema.properties?.plugins as Record<string, unknown> | undefined;
    const pluginProps = pluginsNode?.properties as Record<string, unknown> | undefined;
    const entriesNode = pluginProps?.entries as Record<string, unknown> | undefined;
    const entryProps = entriesNode?.properties as Record<string, unknown> | undefined;

    expect(mockLoadOpenClawPlugins).not.toHaveBeenCalled();
    expect(channelProps?.telegram).toBeTruthy();
    expect(entryProps?.demo).toBeUndefined();
  });
});

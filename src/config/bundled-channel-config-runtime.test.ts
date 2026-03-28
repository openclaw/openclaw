import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedBundledPluginsState = vi.hoisted(() => ({
  plugins: undefined as unknown,
  runtimeSchema: {
    safeParse: vi.fn((value: unknown) => ({ success: true, data: value })),
  },
}));

vi.mock("../channels/plugins/bundled.js", () => {
  const mockedExports: Record<string, unknown> = {};
  Object.defineProperty(mockedExports, "bundledChannelPlugins", {
    enumerable: true,
    get: () => mockedBundledPluginsState.plugins,
  });
  return mockedExports;
});

vi.mock("../plugins/bundled-plugin-metadata.js", () => ({
  BUNDLED_PLUGIN_METADATA: [],
}));

describe("bundled channel config runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    mockedBundledPluginsState.plugins = undefined;
    mockedBundledPluginsState.runtimeSchema.safeParse.mockClear();
  });

  it("rehydrates bundled channel maps after bundled plugins finish initializing", async () => {
    const runtime = await import("./bundled-channel-config-runtime.js");

    const initialSchemaMap = runtime.getBundledChannelConfigSchemaMap();
    expect(initialSchemaMap.has("slack")).toBe(false);
    expect(initialSchemaMap.has("msteams")).toBe(true);

    const slackConfigSchema = {
      schema: {
        type: "object",
        properties: {
          botToken: { type: "string" },
        },
      },
      runtime: mockedBundledPluginsState.runtimeSchema,
    };
    mockedBundledPluginsState.plugins = [
      {
        id: "slack",
        configSchema: slackConfigSchema,
      },
    ];

    const hydratedSchemaMap = runtime.getBundledChannelConfigSchemaMap();
    expect(hydratedSchemaMap.get("slack")).toEqual(slackConfigSchema);
    expect(runtime.getBundledChannelRuntimeMap().get("slack")).toBe(
      mockedBundledPluginsState.runtimeSchema,
    );
  });
});

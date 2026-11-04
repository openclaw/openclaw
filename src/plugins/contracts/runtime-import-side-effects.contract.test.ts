import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";

const listChannelPlugins = vi.hoisted(() => vi.fn(() => []));
const getLoadedChannelPlugin = vi.hoisted(() =>
  vi.fn(() => ({
    id: "telegram",
    messaging: { defaultMarkdownTableMode: "bullets" },
  })),
);
const getActivePluginChannelRegistryVersion = vi.hoisted(() => vi.fn(() => 1));

const HOT_RUNTIME_IMPORT_CASES = [
  [
    "src/plugin-sdk/approval-handler-adapter-runtime.ts",
    () => import("../../plugin-sdk/approval-handler-adapter-runtime.js"),
  ],
  [
    "src/plugin-sdk/approval-gateway-runtime.ts",
    () => import("../../plugin-sdk/approval-gateway-runtime.js"),
  ],
  [
    "src/plugin-sdk/approval-reference-runtime.ts",
    () => import("../../plugin-sdk/approval-reference-runtime.js"),
  ],
  ["src/plugins/runtime/runtime-base.ts", () => import("../runtime/runtime-base.js")],
  ["src/web-search/runtime.ts", () => import("../../web-search/runtime.js")],
  ["src/web-fetch/runtime.ts", () => import("../../web-fetch/runtime.js")],
] as const;

function mockChannelRegistry() {
  vi.doMock("../../channels/plugins/index.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
    normalizeChannelId: (raw?: string | null) => raw ?? null,
  }));
  vi.doMock("../../channels/plugins/registry.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../channels/plugins/registry.js")>()),
    listChannelPlugins,
    getLoadedChannelPlugin,
  }));
  vi.doMock("../../plugins/runtime.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../plugins/runtime.js")>()),
    getActivePluginChannelRegistryVersion,
  }));
}

function expectNoChannelRegistryDuringImport(moduleId: string) {
  expect(listChannelPlugins, `${moduleId} must not boot channel metadata`).not.toHaveBeenCalled();
  expect(getActivePluginChannelRegistryVersion).not.toHaveBeenCalled();
  expect(getLoadedChannelPlugin).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("../../channels/plugins/index.js");
  vi.doUnmock("../../channels/plugins/registry.js");
  vi.doUnmock("../../plugins/runtime.js");
});

describe("runtime import side-effect contracts", () => {
  beforeEach(() => {
    listChannelPlugins.mockClear();
    getLoadedChannelPlugin.mockClear();
    getActivePluginChannelRegistryVersion.mockClear().mockReturnValue(1);
  });

  it("keeps markdown table defaults cold and reads the loaded registry", async () => {
    mockChannelRegistry();
    const markdownTables = await import("../../config/markdown-tables.js");
    const resolve = () =>
      markdownTables.resolveMarkdownTableMode({ channel: "telegram", supportsBlockTables: true });

    expectNoChannelRegistryDuringImport("src/config/markdown-tables.ts");

    expect(resolve()).toBe("bullets");
    getLoadedChannelPlugin.mockReturnValueOnce({
      id: "telegram",
      messaging: { defaultMarkdownTableMode: "block" },
    });
    expect(resolve()).toBe("block");
    expect(getActivePluginChannelRegistryVersion).not.toHaveBeenCalled();
    expect(listChannelPlugins).not.toHaveBeenCalled();
    expect(getLoadedChannelPlugin).toHaveBeenCalledWith("telegram");
  });

  it.each(HOT_RUNTIME_IMPORT_CASES)("keeps %s cold", async (moduleId, importModule) => {
    mockChannelRegistry();
    await importModule();
    expectNoChannelRegistryDuringImport(moduleId);
  });

  it.each(["runtime-channel", "index"])("keeps %s off direct channel registry imports", (name) => {
    const source = fs.readFileSync(`src/plugins/runtime/${name}.ts`, "utf8");
    expect(source).not.toContain("../../channels/plugins/registry");
    expect(source).not.toContain("../channels/plugins/registry");
  });
});

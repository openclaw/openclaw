import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNoImportTimeSideEffects } from "./testkit.js";

const listChannelPlugins = vi.hoisted(() =>
  vi.fn(() => [
    {
      id: "signal",
      messaging: {
        defaultMarkdownTableMode: "bullets",
      },
    },
  ]),
);
const getActivePluginChannelRegistryVersion = vi.hoisted(() => vi.fn(() => 1));

const CHANNEL_REGISTRY_SEAM = "listChannelPlugins()";
const CHANNEL_REGISTRY_WHY =
  "it boots active channel metadata on hot runtime/config import paths and turns cheap module evaluation into plugin registry work.";
const CHANNEL_REGISTRY_FIX =
  "keep the seam behind a lazy getter/runtime boundary so import stays cold and the first real lookup loads once.";

function mockChannelRegistry() {
  vi.doMock("../../channels/plugins/registry.js", async () => {
    const actual = await vi.importActual<typeof import("../../channels/plugins/registry.js")>(
      "../../channels/plugins/registry.js",
    );
    return {
      ...actual,
      listChannelPlugins,
    };
  });
  vi.doMock("../../plugins/runtime.js", async () => {
    const actual = await vi.importActual<typeof import("../../plugins/runtime.js")>(
      "../../plugins/runtime.js",
    );
    return {
      ...actual,
      getActivePluginChannelRegistryVersion,
    };
  });
}

function expectNoChannelRegistryDuringImport(moduleId: string) {
  assertNoImportTimeSideEffects({
    moduleId,
    forbiddenSeam: CHANNEL_REGISTRY_SEAM,
    calls: listChannelPlugins.mock.calls,
    why: CHANNEL_REGISTRY_WHY,
    fixHint: CHANNEL_REGISTRY_FIX,
  });
  expect(getActivePluginChannelRegistryVersion).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("../../channels/plugins/registry.js");
  vi.doUnmock("../../plugins/runtime.js");
});

describe("runtime import side-effect contracts", () => {
  beforeEach(() => {
    listChannelPlugins.mockClear();
    getActivePluginChannelRegistryVersion.mockClear().mockReturnValue(1);
  });

  it("keeps config/markdown-tables cold on import", async () => {
    mockChannelRegistry();
    await import("../../config/markdown-tables.js");

    expectNoChannelRegistryDuringImport("src/config/markdown-tables.ts");
  });

  it("keeps markdown table defaults lazy and memoized after import", async () => {
    mockChannelRegistry();
    const markdownTables = await import("../../config/markdown-tables.js");

    expectNoChannelRegistryDuringImport("src/config/markdown-tables.ts");

    expect(markdownTables.DEFAULT_TABLE_MODES.get("signal")).toBe("bullets");
    expect(getActivePluginChannelRegistryVersion).toHaveBeenCalled();
    expect(listChannelPlugins).toHaveBeenCalledTimes(1);
    expect(markdownTables.DEFAULT_TABLE_MODES.has("signal")).toBe(true);
    expect(getActivePluginChannelRegistryVersion).toHaveBeenCalled();
    expect(listChannelPlugins).toHaveBeenCalledTimes(1);
  });

  it("keeps plugins/runtime/runtime-channel cold on import", async () => {
    mockChannelRegistry();
    await import("../runtime/runtime-channel.js");

    expectNoChannelRegistryDuringImport("src/plugins/runtime/runtime-channel.ts");
  });

  it("keeps plugins/runtime/runtime-system cold on import", async () => {
    mockChannelRegistry();
    await import("../runtime/runtime-system.js");

    expectNoChannelRegistryDuringImport("src/plugins/runtime/runtime-system.ts");
  });

  it("keeps web-search/runtime cold on import", async () => {
    mockChannelRegistry();
    await import("../../web-search/runtime.js");

    expectNoChannelRegistryDuringImport("src/web-search/runtime.ts");
  });

  it("keeps web-fetch/runtime cold on import", async () => {
    mockChannelRegistry();
    await import("../../web-fetch/runtime.js");

    expectNoChannelRegistryDuringImport("src/web-fetch/runtime.ts");
  });

  it("keeps plugins/runtime/index cold on import", async () => {
    mockChannelRegistry();
    await import("../runtime/index.js");

    expectNoChannelRegistryDuringImport("src/plugins/runtime/index.ts");
  });
});

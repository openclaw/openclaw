import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNoImportTimeSideEffects } from "./testkit.js";

const listBootstrapChannelPlugins = vi.hoisted(() =>
  vi.fn(() => [
    {
      id: "signal",
      messaging: {
        defaultMarkdownTableMode: "bullets",
      },
    },
  ]),
);

const BOOTSTRAP_SEAM = "listBootstrapChannelPlugins()";
const BOOTSTRAP_WHY =
  "it boots bundled channel metadata on hot runtime/config import paths and turns cheap module evaluation into channel bootstrap work.";
const BOOTSTRAP_FIX =
  "keep the seam behind a lazy getter/runtime boundary so import stays cold and the first real lookup loads once.";

function mockBootstrapRegistry() {
  vi.doMock("../../channels/plugins/bootstrap-registry.js", async () => {
    const actual =
      await vi.importActual<typeof import("../../channels/plugins/bootstrap-registry.js")>(
        "../../channels/plugins/bootstrap-registry.js",
      );
    return {
      ...actual,
      listBootstrapChannelPlugins,
    };
  });
}

function expectNoBootstrapDuringImport(moduleId: string) {
  assertNoImportTimeSideEffects({
    moduleId,
    forbiddenSeam: BOOTSTRAP_SEAM,
    calls: listBootstrapChannelPlugins.mock.calls,
    why: BOOTSTRAP_WHY,
    fixHint: BOOTSTRAP_FIX,
  });
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("../../channels/plugins/bootstrap-registry.js");
});

describe("runtime import side-effect contracts", () => {
  beforeEach(() => {
    listBootstrapChannelPlugins.mockClear();
  });

  it("keeps config/markdown-tables cold on import", async () => {
    mockBootstrapRegistry();
    await import("../../config/markdown-tables.js");

    expectNoBootstrapDuringImport("src/config/markdown-tables.ts");
  });

  it("keeps markdown table defaults lazy and memoized after import", async () => {
    mockBootstrapRegistry();
    const markdownTables = await import("../../config/markdown-tables.js");

    expectNoBootstrapDuringImport("src/config/markdown-tables.ts");

    expect(markdownTables.DEFAULT_TABLE_MODES.get("signal")).toBe("bullets");
    expect(listBootstrapChannelPlugins).toHaveBeenCalledTimes(1);
    expect(markdownTables.DEFAULT_TABLE_MODES.has("signal")).toBe(true);
    expect(listBootstrapChannelPlugins).toHaveBeenCalledTimes(1);
  });

  it("keeps plugins/runtime/runtime-channel cold on import", async () => {
    mockBootstrapRegistry();
    await import("../runtime/runtime-channel.js");

    expectNoBootstrapDuringImport("src/plugins/runtime/runtime-channel.ts");
  });

  it("keeps plugins/runtime/runtime-system cold on import", async () => {
    mockBootstrapRegistry();
    await import("../runtime/runtime-system.js");

    expectNoBootstrapDuringImport("src/plugins/runtime/runtime-system.ts");
  });

  it("keeps web-search/runtime cold on import", async () => {
    mockBootstrapRegistry();
    await import("../../web-search/runtime.js");

    expectNoBootstrapDuringImport("src/web-search/runtime.ts");
  });

  it("keeps web-fetch/runtime cold on import", async () => {
    mockBootstrapRegistry();
    await import("../../web-fetch/runtime.js");

    expectNoBootstrapDuringImport("src/web-fetch/runtime.ts");
  });

  it("keeps plugins/runtime/index cold on import", async () => {
    mockBootstrapRegistry();
    await import("../runtime/index.js");

    expectNoBootstrapDuringImport("src/plugins/runtime/index.ts");
  });
});

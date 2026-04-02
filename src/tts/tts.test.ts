import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("../plugin-sdk/facade-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin-sdk/facade-runtime.js")>();
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSync,
  };
});

describe("tts runtime facade", () => {
  let ttsModulePromise: Promise<typeof import("./tts.js")> | undefined;

  beforeEach(() => {
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  function importTtsModule() {
    ttsModulePromise ??= import("./tts.js");
    return ttsModulePromise;
  }

  it("does not load speech-core on module import", async () => {
    await importTtsModule();

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("loads speech-core lazily on first runtime access", async () => {
    const buildTtsSystemPromptHint = vi.fn().mockReturnValue("hint");
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      buildTtsSystemPromptHint,
    });

    const tts = await importTtsModule();

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(tts.buildTtsSystemPromptHint({} as never)).toBe("hint");
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledTimes(1);
    expect(buildTtsSystemPromptHint).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const registerMatrixQaCliImpl = vi.hoisted(() => vi.fn());

vi.mock("./facade-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./facade-runtime.js")>("./facade-runtime.js");
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSync,
  };
});

describe("plugin-sdk qa-matrix", () => {
  beforeEach(() => {
    registerMatrixQaCliImpl.mockReset();
    loadBundledPluginPublicSurfaceModuleSync.mockReset().mockReturnValue({
      registerMatrixQaCli: registerMatrixQaCliImpl,
    });
  });

  it("keeps the qa-matrix facade cold until used", async () => {
    const module = await import("./qa-matrix.js");

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    module.registerMatrixQaCli({} as never);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-matrix",
      artifactBasename: "cli.js",
    });
  });

  it("delegates matrix qa cli registration through the public surface", async () => {
    const module = await import("./qa-matrix.js");

    module.registerMatrixQaCli({} as never);
    expect(registerMatrixQaCliImpl).toHaveBeenCalledWith({} as never);
  });

  it("reports qa-matrix unavailable when the public facade is missing", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("Unable to resolve bundled plugin public surface qa-matrix/cli.js");
    });
    const module = await import("./qa-matrix.js");

    expect(module.isMatrixQaCliAvailable()).toBe(false);
  });
});

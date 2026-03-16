import { beforeEach, describe, expect, it, vi } from "vitest";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());

vi.mock("../banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("../plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

vi.mock("./config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

describe("prepareCliExecution", () => {
  let prepareCliExecution: typeof import("./prepare-cli-execution.js").prepareCliExecution;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ prepareCliExecution } = await import("./prepare-cli-execution.js"));
  });

  it("runs banner + config guard + plugin load for enabled flows", async () => {
    await prepareCliExecution({
      argv: ["node", "openclaw", "status"],
      commandPath: ["status"],
      runtime: { error: vi.fn(), log: vi.fn(), exit: vi.fn() } as never,
      bannerVersion: "1.2.3",
      loadPlugins: true,
    });

    expect(emitCliBannerMock).toHaveBeenCalledWith("1.2.3", {
      argv: ["node", "openclaw", "status"],
    });
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      commandPath: ["status"],
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({ scope: "all" });
  });

  it("respects hideBanner, suppressDoctorStdout, and function plugin policy", async () => {
    await prepareCliExecution({
      argv: ["node", "openclaw", "status", "--json"],
      commandPath: ["status"],
      runtime: { error: vi.fn(), log: vi.fn(), exit: vi.fn() } as never,
      bannerVersion: "1.2.3",
      hideBanner: true,
      suppressDoctorStdout: true,
      loadPlugins: (argv) => argv.includes("--json"),
      pluginScope: "channels",
    });

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      commandPath: ["status"],
      suppressDoctorStdout: true,
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({ scope: "channels" });
  });

  it("skips plugin loading when policy resolves false", async () => {
    await prepareCliExecution({
      argv: ["node", "openclaw", "config", "set"],
      commandPath: ["config", "set"],
      runtime: { error: vi.fn(), log: vi.fn(), exit: vi.fn() } as never,
      loadPlugins: false,
    });

    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });
});

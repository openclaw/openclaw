import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const findRoutedCommandMock = vi.hoisted(() => vi.fn());
const runRouteMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("./plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

vi.mock("./program/routes.js", () => ({
  findRoutedCommand: findRoutedCommandMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), log: vi.fn(), exit: vi.fn() },
}));

describe("tryRouteCli", () => {
  let tryRouteCli: typeof import("./route.js").tryRouteCli;
  let originalDisableRouteFirst: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalDisableRouteFirst = process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    delete process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    vi.resetModules();
    ({ tryRouteCli } = await import("./route.js"));
    findRoutedCommandMock.mockReturnValue({
      loadPlugins: false,
      run: runRouteMock,
    });
  });

  afterEach(() => {
    if (originalDisableRouteFirst === undefined) {
      delete process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    } else {
      process.env.OPENCLAW_DISABLE_ROUTE_FIRST = originalDisableRouteFirst;
    }
  });

  it("passes suppressDoctorStdout=true for routed --json commands", async () => {
    await expect(tryRouteCli(["node", "openclaw", "status", "--json"])).resolves.toBe(true);

    expect(ensureConfigReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commandPath: ["status"],
        suppressDoctorStdout: true,
      }),
    );
  });

  it("does not pass suppressDoctorStdout for routed non-json commands", async () => {
    await expect(tryRouteCli(["node", "openclaw", "status"])).resolves.toBe(true);

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      commandPath: ["status"],
    });
  });
});

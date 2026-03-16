import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareCliExecutionMock = vi.hoisted(() => vi.fn(async () => {}));
const findRoutedCommandMock = vi.hoisted(() => vi.fn());
const runRouteMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./program/prepare-cli-execution.js", () => ({
  prepareCliExecution: prepareCliExecutionMock,
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
      loadPlugins: (argv: string[]) => !argv.includes("--json"),
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

    expect(prepareCliExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["node", "openclaw", "status", "--json"],
        commandPath: ["status"],
        loadPlugins: false,
        pluginScope: undefined,
        suppressDoctorStdout: true,
      }),
    );
  });

  it("does not pass suppressDoctorStdout for routed non-json commands", async () => {
    await expect(tryRouteCli(["node", "openclaw", "status"])).resolves.toBe(true);

    expect(prepareCliExecutionMock).toHaveBeenCalledWith({
      argv: ["node", "openclaw", "status"],
      commandPath: ["status"],
      runtime: expect.any(Object),
      bannerVersion: expect.any(String),
      loadPlugins: true,
      pluginScope: "channels",
      suppressDoctorStdout: false,
    });
  });

  it("routes status when root options precede the command", async () => {
    await expect(tryRouteCli(["node", "openclaw", "--log-level", "debug", "status"])).resolves.toBe(
      true,
    );

    expect(findRoutedCommandMock).toHaveBeenCalledWith(["status"]);
    expect(prepareCliExecutionMock).toHaveBeenCalledWith({
      argv: ["node", "openclaw", "--log-level", "debug", "status"],
      commandPath: ["status"],
      runtime: expect.any(Object),
      bannerVersion: expect.any(String),
      loadPlugins: true,
      pluginScope: "channels",
      suppressDoctorStdout: false,
    });
  });
});

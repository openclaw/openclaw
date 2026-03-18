import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tryRouteCliMock = vi.hoisted(() => vi.fn());
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const ensurePathMock = vi.hoisted(() => vi.fn());
const assertRuntimeMock = vi.hoisted(() => vi.fn());
const closeAllMemorySearchManagersMock = vi.hoisted(() => vi.fn(async () => {}));
const outputRootHelpMock = vi.hoisted(() => vi.fn());
const buildProgramMock = vi.hoisted(() => vi.fn());
const enableConsoleCaptureMock = vi.hoisted(() => vi.fn());
const routeLogsToStderrMock = vi.hoisted(() => vi.fn());
const parseAsyncMock = vi.hoisted(() => vi.fn(async () => {}));
const getProgramContextMock = vi.hoisted(() => vi.fn());
const registerCoreCliByNameMock = vi.hoisted(() => vi.fn());
const registerSubCliByNameMock = vi.hoisted(() => vi.fn());
const registerPluginCliCommandsMock = vi.hoisted(() => vi.fn());
const loadValidatedConfigForPluginRegistrationMock = vi.hoisted(() => vi.fn());
const installUnhandledRejectionHandlerMock = vi.hoisted(() => vi.fn());

vi.mock("./route.js", () => ({
  tryRouteCli: tryRouteCliMock,
}));

vi.mock("./dotenv.js", () => ({
  loadCliDotEnv: loadDotEnvMock,
}));

vi.mock("../infra/env.js", () => ({
  normalizeEnv: normalizeEnvMock,
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: ensurePathMock,
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: assertRuntimeMock,
}));

vi.mock("../memory/search-manager.js", () => ({
  closeAllMemorySearchManagers: closeAllMemorySearchManagersMock,
}));

vi.mock("./program/root-help.js", () => ({
  outputRootHelp: outputRootHelpMock,
}));

vi.mock("./program.js", () => ({
  buildProgram: buildProgramMock,
}));

vi.mock("../infra/unhandled-rejections.js", () => ({
  installUnhandledRejectionHandler: installUnhandledRejectionHandlerMock,
}));

vi.mock("../logging.js", () => ({
  enableConsoleCapture: enableConsoleCaptureMock,
  routeLogsToStderr: routeLogsToStderrMock,
}));

vi.mock("./program/program-context.js", () => ({
  getProgramContext: getProgramContextMock,
}));

vi.mock("./program/command-registry.js", () => ({
  registerCoreCliByName: registerCoreCliByNameMock,
}));

vi.mock("./program/register.subclis.js", () => ({
  registerSubCliByName: registerSubCliByNameMock,
  loadValidatedConfigForPluginRegistration: loadValidatedConfigForPluginRegistrationMock,
}));

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommands: registerPluginCliCommandsMock,
}));

const { runCli } = await import("./run-main.js");

describe("runCli exit behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getProgramContextMock.mockReturnValue({});
    buildProgramMock.mockReturnValue({
      commands: [],
      parseAsync: parseAsyncMock,
    });
    loadValidatedConfigForPluginRegistrationMock.mockResolvedValue(undefined);
    parseAsyncMock.mockClear();
  });

  it("does not force process.exit after successful routed command", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(closeAllMemorySearchManagersMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("renders root help without building the full program", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "--help"]);

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(outputRootHelpMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeAllMemorySearchManagersMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("routes ACP stdout logging to stderr before command registration", async () => {
    const callOrder: string[] = [];

    routeLogsToStderrMock.mockImplementation(() => {
      callOrder.push("route");
    });
    registerCoreCliByNameMock.mockImplementation(() => {
      callOrder.push("core");
    });
    registerSubCliByNameMock.mockImplementation(() => {
      callOrder.push("sub");
    });
    registerPluginCliCommandsMock.mockImplementation(() => {
      callOrder.push("plugin");
    });

    loadValidatedConfigForPluginRegistrationMock.mockResolvedValue({});

    await runCli(["node", "openclaw", "acp"]);

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(callOrder[0]).toBe("route");
    expect(callOrder).toContain("core");
    expect(callOrder).toContain("sub");
    expect(callOrder.indexOf("core")).toBeGreaterThan(callOrder.indexOf("route"));
    expect(callOrder.indexOf("sub")).toBeGreaterThan(callOrder.indexOf("route"));
    expect(registerPluginCliCommandsMock).toHaveBeenCalledTimes(1);
    expect(callOrder.indexOf("plugin")).toBeGreaterThan(callOrder.indexOf("route"));
  });

  it("does not force ACP log redirection for non-acp commands", async () => {
    await runCli(["node", "openclaw", "status"]);

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
    expect(registerCoreCliByNameMock).toHaveBeenCalled();
  });

  it("does not route ACP logs to stderr for interactive client mode", async () => {
    await runCli(["node", "openclaw", "acp", "client"]);

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
  });

  it("does not route ACP logs to stderr for interactive client mode options", async () => {
    await runCli(["node", "openclaw", "acp", "client", "--cwd", "/tmp"]);

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
  });

  it("does not route ACP logs to stderr when acp option-value resembles a subcommand", async () => {
    await runCli(["node", "openclaw", "acp", "--session", "client"]);

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
  });

  it("does not route ACP logs to stderr for acp session-label option values that look like 'client'", async () => {
    await runCli(["node", "openclaw", "acp", "--session-label", "client"]);

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
  });

  it("routes ACP stdout logging even when acp includes option values", async () => {
    registerSubCliByNameMock.mockImplementation(() => {});

    loadValidatedConfigForPluginRegistrationMock.mockResolvedValue({});

    await runCli(["node", "openclaw", "acp", "--url", "wss://example.local"]);

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
  });
});

import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tryRouteCliMock = vi.hoisted(() => vi.fn());
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const ensurePathMock = vi.hoisted(() => vi.fn());
const assertRuntimeMock = vi.hoisted(() => vi.fn());
const closeActiveMemorySearchManagersMock = vi.hoisted(() => vi.fn(async () => {}));
const outputRootHelpMock = vi.hoisted(() => vi.fn());
const buildProgramMock = vi.hoisted(() => vi.fn());
const maintainLocalConfigJsonSchemaArtifactsMock = vi.hoisted(() => vi.fn(async () => {}));
const registerPluginCliCommandsMock = vi.hoisted(() => vi.fn());
const loadValidatedConfigForPluginRegistrationMock = vi.hoisted(() => vi.fn(async () => undefined));
const maybeRunCliInContainerMock = vi.hoisted(() =>
  vi.fn<
    (argv: string[]) => { handled: true; exitCode: number } | { handled: false; argv: string[] }
  >((argv: string[]) => ({ handled: false, argv })),
);

vi.mock("./route.js", () => ({
  tryRouteCli: tryRouteCliMock,
}));

vi.mock("./container-target.js", () => ({
  maybeRunCliInContainer: maybeRunCliInContainerMock,
  parseCliContainerArgs: (argv: string[]) => ({ ok: true, container: null, argv }),
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

vi.mock("../plugins/memory-runtime.js", () => ({
  closeActiveMemorySearchManagers: closeActiveMemorySearchManagersMock,
}));

vi.mock("./program/root-help.js", () => ({
  outputRootHelp: outputRootHelpMock,
}));

vi.mock("./program.js", () => ({
  buildProgram: buildProgramMock,
}));

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommands: registerPluginCliCommandsMock,
}));

vi.mock("./program/register.subclis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./program/register.subclis.js")>()),
  loadValidatedConfigForPluginRegistration: loadValidatedConfigForPluginRegistrationMock,
}));

vi.mock("../config/local-json-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/local-json-schema.js")>()),
  maintainLocalConfigJsonSchemaArtifacts: maintainLocalConfigJsonSchemaArtifactsMock,
}));

const { runCli } = await import("./run-main.js");

describe("runCli exit behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not force process.exit after successful routed command", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(closeActiveMemorySearchManagersMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("renders root help without building the full program", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "--help"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "openclaw", "--help"]);
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(outputRootHelpMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("maintains local schema artifacts on bare root invocation", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsyncMock = vi.fn(async () => {});
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync: parseAsyncMock });

    await runCli(["node", "openclaw"]);

    expect(maintainLocalConfigJsonSchemaArtifactsMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).toHaveBeenCalledTimes(1);
    expect(parseAsyncMock).toHaveBeenCalledWith(["node", "openclaw"]);
  });

  it.each(["--version", "-v"])("does not maintain local schema artifacts for %s", async (flag) => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsyncMock = vi.fn(async () => {});
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync: parseAsyncMock });

    await runCli(["node", "openclaw", flag]);

    expect(maintainLocalConfigJsonSchemaArtifactsMock).not.toHaveBeenCalled();
    expect(buildProgramMock).toHaveBeenCalledTimes(1);
    expect(parseAsyncMock).toHaveBeenCalledWith(["node", "openclaw", flag]);
  });

  it("returns after a handled container-target invocation", async () => {
    maybeRunCliInContainerMock.mockReturnValueOnce({ handled: true, exitCode: 0 });

    await runCli(["node", "openclaw", "--container", "demo", "status"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "--container",
      "demo",
      "status",
    ]);
    expect(loadDotEnvMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
  });

  it("propagates a handled container-target exit code", async () => {
    const exitCode = process.exitCode;
    maybeRunCliInContainerMock.mockReturnValueOnce({ handled: true, exitCode: 7 });

    await runCli(["node", "openclaw", "--container", "demo", "status"]);

    expect(process.exitCode).toBe(7);
    process.exitCode = exitCode;
  });
});

import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tryRouteCliMock = vi.hoisted(() => vi.fn());
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const ensurePathMock = vi.hoisted(() => vi.fn());
const assertRuntimeMock = vi.hoisted(() => vi.fn());
const closeAllMemorySearchManagersMock = vi.hoisted(() => vi.fn(async () => {}));
const resetMemoryRuntimeUsageMock = vi.hoisted(() => vi.fn());
const wasMemoryRuntimeUsedMock = vi.hoisted(() => vi.fn(() => true));
const outputRootHelpMock = vi.hoisted(() => vi.fn());
const buildProgramMock = vi.hoisted(() => vi.fn());

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

vi.mock("../memory/runtime-usage.js", () => ({
  resetMemoryRuntimeUsage: resetMemoryRuntimeUsageMock,
  wasMemoryRuntimeUsed: wasMemoryRuntimeUsedMock,
}));

vi.mock("./program/root-help.js", () => ({
  outputRootHelp: outputRootHelpMock,
}));

vi.mock("./program.js", () => ({
  buildProgram: buildProgramMock,
}));

const { runCli } = await import("./run-main.js");

describe("runCli exit behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wasMemoryRuntimeUsedMock.mockReturnValue(true);
  });

  it("does not force process.exit after successful routed command", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(closeAllMemorySearchManagersMock).toHaveBeenCalledTimes(1);
    expect(resetMemoryRuntimeUsageMock).toHaveBeenCalledTimes(1);
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
    expect(resetMemoryRuntimeUsageMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

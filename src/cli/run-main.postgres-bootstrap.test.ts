import { beforeEach, describe, expect, it, vi } from "vitest";

const tryRouteCliMock = vi.hoisted(() => vi.fn(async () => true));
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const ensurePathMock = vi.hoisted(() => vi.fn());
const assertRuntimeMock = vi.hoisted(() => vi.fn());
const closeAllMemorySearchManagersMock = vi.hoisted(() => vi.fn(async () => {}));
const loadValidatedConfigMock = vi.hoisted(() => vi.fn<() => Promise<unknown>>(async () => null));
const bootstrapPostgresRuntimeStateMock = vi.hoisted(() => vi.fn(async () => undefined));
const clearPostgresRuntimeStateMock = vi.hoisted(() => vi.fn());

vi.mock("./route.js", () => ({
  tryRouteCli: tryRouteCliMock,
}));

vi.mock("../infra/dotenv.js", () => ({
  loadDotEnv: loadDotEnvMock,
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

vi.mock("./program/register.subclis.js", () => ({
  loadValidatedConfigForPluginRegistration: loadValidatedConfigMock,
}));

vi.mock("../persistence/runtime.js", () => ({
  bootstrapPostgresRuntimeState: bootstrapPostgresRuntimeStateMock,
  clearPostgresRuntimeState: clearPostgresRuntimeStateMock,
}));

vi.mock("./windows-argv.js", () => ({
  normalizeWindowsArgv: (argv: string[]) => argv,
}));

const { runCli } = await import("./run-main.js");

describe("runCli postgres runtime bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadValidatedConfigMock.mockResolvedValue(null);
  });

  it("bootstraps postgres runtime state for routed model commands and clears it on exit", async () => {
    const config = { persistence: { backend: "postgres" } };
    loadValidatedConfigMock.mockResolvedValueOnce(config);

    await runCli(["node", "openclaw", "models", "list", "--json"]);

    expect(loadValidatedConfigMock).toHaveBeenCalledTimes(1);
    expect(bootstrapPostgresRuntimeStateMock).toHaveBeenCalledWith({
      config,
      env: process.env,
    });
    expect(clearPostgresRuntimeStateMock).toHaveBeenCalledTimes(1);
    expect(closeAllMemorySearchManagersMock).toHaveBeenCalledTimes(1);
  });

  it("skips postgres runtime bootstrap for read-only fast routes", async () => {
    await runCli(["node", "openclaw", "status", "--json"]);

    expect(loadValidatedConfigMock).not.toHaveBeenCalled();
    expect(bootstrapPostgresRuntimeStateMock).not.toHaveBeenCalled();
    expect(clearPostgresRuntimeStateMock).not.toHaveBeenCalled();
    expect(closeAllMemorySearchManagersMock).toHaveBeenCalledTimes(1);
  });
});

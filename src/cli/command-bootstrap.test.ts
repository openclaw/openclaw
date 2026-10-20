import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";

const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCliPluginRegistryLoadedMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("./plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: ensureCliPluginRegistryLoadedMock,
}));

describe("ensureCliExecutionBootstrap", () => {
  let ensureCliExecutionBootstrap: typeof import("./command-execution-startup.js").ensureCliExecutionBootstrap;
  const runtime = {} as never;

  async function bootstrap(
    commandPath: string[],
    options: {
      jsonOutputMode?: boolean;
      allowInvalid?: boolean;
      loadPlugins?: boolean;
    } = {},
  ) {
    const { jsonOutputMode = false, allowInvalid, loadPlugins = true } = options;
    await ensureCliExecutionBootstrap({
      runtime,
      commandPath,
      allowInvalid,
      loadPlugins,
      startupPolicy: {
        ...resolveCliStartupPolicy({ commandPath, jsonOutputMode, env: {} }),
        skipConfigGuard: false,
        loadPlugins: false,
      },
    });
  }

  beforeAll(async () => {
    vi.resetModules();
    ({ ensureCliExecutionBootstrap } = await import("./command-execution-startup.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs config guard and plugin loading with shared options", async () => {
    await bootstrap(["agents", "list"], { jsonOutputMode: true, allowInvalid: true });
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime,
      commandPath: ["agents", "list"],
      measure: expect.any(Function),
      allowInvalid: true,
      suppressDoctorStdout: true,
    });
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
      routeLogsToStderr: true,
    });
  });

  it("uses validation-only admission for managed worktree commands", async () => {
    await bootstrap(["worktrees", "gc"], { loadPlugins: false });
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime,
      commandPath: ["worktrees", "gc"],
      measure: expect.any(Function),
      validateConfigOnly: true,
    });
  });

  it("loads agent command plugins without package-manager repair", async () => {
    await bootstrap(["agent"]);
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
      routeLogsToStderr: false,
    });
  });

  it("loads configured and persisted backend owners for sandbox management", async () => {
    await bootstrap(["sandbox", "list"]);
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "sandbox-management",
      routeLogsToStderr: false,
    });
  });
});

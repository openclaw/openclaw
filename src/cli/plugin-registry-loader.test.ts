import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());

vi.mock("./plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

describe("plugin-registry-loader", () => {
  let originalForceStderr: boolean;
  let ensureCliPluginRegistryLoaded: typeof import("./plugin-registry-loader.js").ensureCliPluginRegistryLoaded;
  let resolvePluginRegistryLoadPolicyForCommandPath: typeof import("./plugin-registry-loader.js").resolvePluginRegistryLoadPolicyForCommandPath;
  let loggingState: typeof import("../logging/state.js").loggingState;

  beforeAll(async () => {
    ({ ensureCliPluginRegistryLoaded, resolvePluginRegistryLoadPolicyForCommandPath } =
      await import("./plugin-registry-loader.js"));
    ({ loggingState } = await import("../logging/state.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    originalForceStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = false;
  });

  afterEach(() => {
    loggingState.forceConsoleToStderr = originalForceStderr;
  });

  it("routes plugin load logs to stderr and restores state", async () => {
    const captured: boolean[] = [];
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
      routeLogsToStderr: true,
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
    expect(captured).toEqual([true]);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("keeps stdout routing unchanged when stderr routing is not requested", async () => {
    const captured: boolean[] = [];
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await ensureCliPluginRegistryLoaded({
      scope: "all",
    });

    expect(captured).toEqual([false]);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("forwards explicit config snapshots to plugin loading", async () => {
    const config = { channels: { quietchat: { enabled: true } } } as never;
    const activationSourceConfig = { channels: { quietchat: { enabled: true } } } as never;

    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
      config,
      activationSourceConfig,
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
      config,
      activationSourceConfig,
    });
  });

  it("forwards explicit runtime dependency install policy", async () => {
    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
      installBundledRuntimeDeps: false,
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
      installBundledRuntimeDeps: false,
    });
  });

  it("maps command paths to plugin registry load policy", () => {
    expect(resolvePluginRegistryLoadPolicyForCommandPath(["status"])).toEqual({
      scope: "channels",
      installBundledRuntimeDeps: false,
    });
    expect(resolvePluginRegistryLoadPolicyForCommandPath(["health"])).toEqual({
      scope: "channels",
      installBundledRuntimeDeps: false,
    });
    expect(resolvePluginRegistryLoadPolicyForCommandPath(["channels", "send"])).toEqual({
      scope: "configured-channels",
      installBundledRuntimeDeps: false,
    });
    expect(resolvePluginRegistryLoadPolicyForCommandPath(["agents"])).toEqual({
      scope: "all",
    });
  });
});

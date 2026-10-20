import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";

const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCliPluginRegistryLoadedMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./program/config-guard.js", () => ({ ensureConfigReady: ensureConfigReadyMock }));
vi.mock("./plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: ensureCliPluginRegistryLoadedMock,
}));

type GuardOptions = {
  allowInvalid?: boolean;
  suppressDoctorStdout?: boolean;
  validateConfigOnly?: boolean;
};
const cases: [string, GuardOptions, string | null][] = [
  ["agents/list", { allowInvalid: true, suppressDoctorStdout: true }, "all"],
  ["worktrees/gc", { validateConfigOnly: true }, null],
  ["agent", {}, "all"],
  ["sandbox/list", {}, "sandbox-management"],
];

describe("ensureCliExecutionBootstrap", () => {
  let bootstrap: typeof import("./command-execution-startup.js").ensureCliExecutionBootstrap;
  beforeAll(async () => {
    vi.resetModules();
    ({ ensureCliExecutionBootstrap: bootstrap } = await import("./command-execution-startup.js"));
  });
  beforeEach(() => vi.clearAllMocks());

  it.each(cases)("applies config and plugin policy for %s", async (command, guard, scope) => {
    const runtime = {} as never;
    const commandPath = command.split("/");
    const jsonOutputMode = guard.suppressDoctorStdout ?? false;
    await bootstrap({
      runtime,
      commandPath,
      allowInvalid: guard.allowInvalid,
      loadPlugins: scope !== null,
      startupPolicy: {
        ...resolveCliStartupPolicy({ commandPath, jsonOutputMode, env: {} }),
        skipConfigGuard: false,
        loadPlugins: false,
      },
    });
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime,
      commandPath,
      measure: expect.any(Function),
      ...guard,
    });
    if (scope === null) {
      expect(ensureCliPluginRegistryLoadedMock).not.toHaveBeenCalled();
    } else {
      expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
        scope,
        routeLogsToStderr: jsonOutputMode,
      });
    }
  });
});

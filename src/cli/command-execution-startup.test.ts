import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { resolveCliStartupPolicy } from "./command-startup-policy.js";

function startupPolicy(overrides: Partial<ReturnType<typeof resolveCliStartupPolicy>> = {}) {
  return {
    suppressDoctorStdout: true,
    hideBanner: false,
    skipConfigGuard: false,
    loadPlugins: false,
    pluginRegistry: { scope: "channels" as const },
    ...overrides,
  };
}

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const routeLogsToStderrMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCliPluginRegistryLoadedMock = vi.hoisted(() => vi.fn(async () => {}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// mock-isolation: Observe startup ordering without emitting a real terminal banner.
vi.mock("./banner.js", () => ({ emitCliBanner: emitCliBannerMock }));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return { ...actual, routeLogsToStderr: routeLogsToStderrMock };
});

// mock-isolation: Control startup admission without loading operator configuration.
vi.mock("./program/config-guard.js", () => ({ ensureConfigReady: ensureConfigReadyMock }));

vi.mock("./plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: ensureCliPluginRegistryLoadedMock,
}));

describe("command-execution-startup", () => {
  let mod: typeof import("./command-execution-startup.js");
  const argv = ["node", "openclaw", "status"];
  const cliRuntime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./command-execution-startup.js");
  });

  beforeEach(() => vi.clearAllMocks());

  it("preserves console exports for a co-sharded subsystem logger", async () => {
    const { createSubsystemLogger } = await import("../logging/subsystem.js");

    expect(() =>
      createSubsystemLogger("test/cli-startup").isEnabled("info", "console"),
    ).not.toThrow();
  });

  it.each([
    { name: "normal", startupPolicy: startupPolicy(), argv, banner: true },
    {
      name: "hidden",
      startupPolicy: startupPolicy({ suppressDoctorStdout: false, hideBanner: true }),
      showBanner: true,
      banner: false,
    },
    { name: "json", startupPolicy: startupPolicy(), argv: [...argv, "--json"], banner: false },
  ])("routes diagnostics and respects $name banner policy", async ({ banner, ...params }) => {
    await mod.applyCliExecutionStartupPresentation({ ...params, version: "1.2.3" });
    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(
      Number(params.startupPolicy.suppressDoctorStdout),
    );
    expect(emitCliBannerMock.mock.calls).toEqual(banner ? [["1.2.3", { argv }]] : []);
  });

  it.each([false, true])("forwards bootstrap policy with overrides=%s", async (overrides) => {
    const commandPath = overrides ? ["message", "send"] : ["status"];
    await mod.ensureCliExecutionBootstrap({
      runtime: cliRuntime,
      commandPath,
      startupPolicy: startupPolicy({
        suppressDoctorStdout: !overrides,
        pluginRegistry: { scope: overrides ? "all" : "channels" },
      }),
      ...(overrides ? { allowInvalid: true, loadPlugins: true } : {}),
    });
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: cliRuntime,
      commandPath,
      measure: expect.any(Function),
      ...(overrides ? { allowInvalid: true } : { suppressDoctorStdout: true }),
    });
    expect(ensureCliPluginRegistryLoadedMock.mock.calls).toEqual(
      overrides ? [[{ scope: "all", routeLogsToStderr: false }]] : [],
    );
  });

  it.each([
    { commandPath: ["gateway"] },
    { commandPath: ["gateway", "run"] },
    { commandPath: ["doctor"] },
  ])(
    "prepares fresh $commandPath snapshots asynchronously without runtime activation ownership",
    async ({ commandPath }) => {
      const root = tempDirs.make("openclaw-cli-snapshot-preparation-");
      const configPath = path.join(root, "openclaw.json");
      const env = {
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        VITEST: "true",
      };
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      const [{ createConfigIoContext }, snapshots, metadata, runtime, lifecycle, state] =
        await Promise.all([
          import("../config/io.context.js"),
          import("../config/io.snapshot.js"),
          import("../config/io.plugin-metadata.js"),
          import("../config/runtime-snapshot.js"),
          import("../plugins/plugin-metadata-lifecycle.js"),
          import("../state/openclaw-state-db.js"),
        ]);
      const context = createConfigIoContext({
        configPath,
        env,
        homedir: () => root,
        observe: false,
      });
      const prepare = vi.spyOn(metadata, "resolveConfigWidePluginMetadataSnapshotAsync");
      ensureConfigReadyMock.mockImplementationOnce(async () => {
        expect(runtime.hasManagedRuntimeConfigWriteOwner(configPath)).toBe(false);
        await expect(
          runtime.preflightManagedRuntimeConfigWrite(
            configPath,
            {},
            { requireImmediateApplication: true },
          ),
        ).rejects.toThrow("The Gateway cannot apply this activation");
        for (const port of [19001, 19002]) {
          fs.writeFileSync(
            configPath,
            JSON.stringify({ gateway: { mode: "local", port }, plugins: { enabled: false } }),
          );
          const result = await snapshots.readConfigFileSnapshotWithPluginMetadataFromContext(
            context,
            {
              allowCurrentPluginMetadata: false,
            },
          );
          expect(result.snapshot).toMatchObject({
            issues: [],
            valid: true,
            config: { gateway: { port } },
          });
          expect(result.pluginMetadataSnapshot).toBeDefined();
        }
      });
      try {
        await mod.ensureCliExecutionBootstrap({
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          commandPath,
          startupPolicy: startupPolicy({ hideBanner: true, pluginRegistry: { scope: "all" } }),
        });
        expect(prepare).toHaveBeenCalledTimes(2);
      } finally {
        prepare.mockRestore();
        vi.unstubAllEnvs();
        lifecycle.clearPluginMetadataLifecycleCaches();
        state.closeOpenClawStateDatabaseForTest();
      }
    },
  );
});

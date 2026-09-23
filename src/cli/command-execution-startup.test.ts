// Command execution startup tests cover startup behavior before CLI command execution.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const routeLogsToStderrMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCliPluginRegistryLoadedMock = vi.hoisted(() => vi.fn(async () => {}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("./banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    routeLogsToStderr: routeLogsToStderrMock,
  };
});

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("./plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: ensureCliPluginRegistryLoadedMock,
}));

describe("command-execution-startup", () => {
  let mod: typeof import("./command-execution-startup.js");

  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./command-execution-startup.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves console exports for a co-sharded subsystem logger", async () => {
    const { createSubsystemLogger } = await import("../logging/subsystem.js");

    expect(() =>
      createSubsystemLogger("test/cli-startup").isEnabled("info", "console"),
    ).not.toThrow();
  });

  it("routes logs to stderr and emits banner only when allowed", async () => {
    await mod.applyCliExecutionStartupPresentation({
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: true,
        pluginRegistry: { scope: "all" },
      },
      version: "1.2.3",
      argv: ["node", "openclaw", "status"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(emitCliBannerMock).toHaveBeenCalledWith("1.2.3", {
      argv: ["node", "openclaw", "status"],
    });

    await mod.applyCliExecutionStartupPresentation({
      startupPolicy: {
        suppressDoctorStdout: false,
        hideBanner: true,
        skipConfigGuard: false,
        loadPlugins: true,
        pluginRegistry: { scope: "all" },
      },
      version: "1.2.3",
      showBanner: true,
    });

    expect(emitCliBannerMock).toHaveBeenCalledTimes(1);
  });

  it("does not emit the banner for JSON output", async () => {
    await mod.applyCliExecutionStartupPresentation({
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: false,
        pluginRegistry: { scope: "channels" },
      },
      version: "1.2.3",
      argv: ["node", "openclaw", "status", "--json"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(emitCliBannerMock).not.toHaveBeenCalled();
  });

  it("forwards startup policy into bootstrap defaults and overrides", async () => {
    const statusRuntime = {} as never;
    await mod.ensureCliExecutionBootstrap({
      runtime: statusRuntime,
      commandPath: ["status"],
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: false,
        pluginRegistry: { scope: "channels" },
      },
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: statusRuntime,
      commandPath: ["status"],
      measure: expect.any(Function),
      suppressDoctorStdout: true,
    });
    expect(ensureCliPluginRegistryLoadedMock).not.toHaveBeenCalled();

    const messageRuntime = {} as never;
    await mod.ensureCliExecutionBootstrap({
      runtime: messageRuntime,
      commandPath: ["message", "send"],
      startupPolicy: {
        suppressDoctorStdout: false,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: false,
        pluginRegistry: { scope: "all" },
      },
      allowInvalid: true,
      loadPlugins: true,
      skipPristineCoreStateMigrations: true,
      skipPristineStartupStateMigrations: true,
    });

    expect(ensureConfigReadyMock).toHaveBeenLastCalledWith({
      runtime: messageRuntime,
      commandPath: ["message", "send"],
      measure: expect.any(Function),
      allowInvalid: true,
      skipPristineCoreStateMigrations: true,
      skipPristineStartupStateMigrations: true,
    });
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
      routeLogsToStderr: false,
    });
  });

  it.each([
    { commandPath: ["gateway"], asyncReads: 2 },
    { commandPath: ["gateway", "run"], asyncReads: 2 },
    { commandPath: ["doctor"], asyncReads: 0 },
  ])(
    "routes fresh $commandPath snapshots through their host preparation",
    async ({ commandPath, asyncReads }) => {
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
      const captures: Array<ReturnType<typeof runtime.captureManagedConfigSnapshotPreparation>> =
        [];
      ensureConfigReadyMock.mockImplementationOnce(async () => {
        captures.push(runtime.captureManagedConfigSnapshotPreparation(configPath));
        expect(
          runtime.captureManagedConfigSnapshotPreparation(path.join(root, "other.json")),
        ).toBeNull();
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
          expect(result.snapshot.issues).toEqual([]);
          expect(result.snapshot.valid).toBe(true);
          expect(result.snapshot.config.gateway?.port).toBe(port);
          expect(result.pluginMetadataSnapshot).toBeDefined();
        }
      });
      try {
        await mod.ensureCliExecutionBootstrap({
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          commandPath,
          startupPolicy: {
            suppressDoctorStdout: true,
            hideBanner: true,
            skipConfigGuard: false,
            loadPlugins: false,
            pluginRegistry: { scope: "all" },
          },
        });
        expect(prepare).toHaveBeenCalledTimes(asyncReads);
        expect(runtime.captureManagedConfigSnapshotPreparation(configPath)).toBeNull();
        const captured = captures[0];
        if (asyncReads > 0) {
          if (!captured) {
            throw new Error("Gateway bootstrap did not own snapshot preparation");
          }
          await expect(captured(async () => undefined)).rejects.toThrow(
            "snapshot preparation owner has closed",
          );
        } else {
          expect(captured).toBeNull();
        }
      } finally {
        prepare.mockRestore();
        vi.unstubAllEnvs();
        lifecycle.clearPluginMetadataLifecycleCaches();
        state.closeOpenClawStateDatabaseForTest();
      }
    },
  );
});

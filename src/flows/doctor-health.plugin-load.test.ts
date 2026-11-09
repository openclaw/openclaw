import "./doctor-health.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { doctorCommand } from "../commands/doctor.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import * as pluginSourceFiles from "../plugins/plugin-source-file.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const { mocks, createDoctorRuntime, stubDoctorEnv } =
  await import("./doctor-health.test-support.js");

vi.mock("../plugins/plugin-source-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-source-file.js")>()),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "reports plugin ENOSPC with its corresponding outcome (update: %s)",
  async (updating) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const resultPath = state.path("doctor-result.json");
      stubDoctorEnv({
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_UPDATE_IN_PROGRESS: updating ? "1" : undefined,
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: updating ? "1" : undefined,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: updating ? resultPath : undefined,
      });
      mocks.packageRoot.mockReturnValue(undefined);
      mocks.outro.mockClear();
      mocks.writeUpdatePostInstallDoctorResult.mockClear();
      const id = "doctor-load-fixture";
      const root = state.statePath("plugin");
      const source = await state.writeText(
        "plugin/index.cjs",
        `module.exports = { id: "${id}", register() {} };`,
      );
      await state.writeJson("plugin/openclaw.plugin.json", {
        id,
        configSchema: { type: "object", properties: {} },
      });
      const cfg = {
        plugins: { allow: [id], load: { paths: [root] }, slots: { memory: "none" } },
      };
      mocks.config.mockReturnValue(cfg);
      // Copy-owner tests cover fs-safe translation; Doctor consumes this capture boundary.
      const copy = pluginSourceFiles.copyPluginSourceFile;
      vi.spyOn(pluginSourceFiles, "copyPluginSourceFile").mockImplementation((...args) => {
        if (args[0] === source) {
          throw Object.assign(new Error("fixture capture write failed"), { code: "ENOSPC" });
        }
        return copy(...args);
      });
      mocks.runContributions.mockImplementation(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const registry = loadPluginRegistryHandle({ config: cfg, cache: false });
          await disposePluginRegistryInstances(registry);
        }
      });
      const runtime = createDoctorRuntime();
      await doctorCommand(runtime, { nonInteractive: true });
      expect(runtime.exit.mock.calls).toEqual(updating ? [] : [[1]]);
      if (updating) {
        expect(mocks.writeUpdatePostInstallDoctorResult.mock.lastCall?.[0]).toMatchObject({
          resultPath,
          result: {
            status: "ok",
            warnings: [expect.stringContaining(source)],
          },
        });
      }
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          `- Plugin ${id}: plugin failed during load: ENOSPC: no space left on device; free space on the filesystem used by the plugin load and rerun Doctor`,
        ),
      );
      expect(runtime.error.mock.calls.flat().join("\n")).toContain(source);
      expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
      // A later invocation must not inherit released inspection failures.
      mocks.runContributions.mockResolvedValue(undefined);
      runtime.exit.mockClear();
      runtime.error.mockClear();
      await doctorCommand(runtime, { nonInteractive: true });
      expect([runtime.exit.mock.calls, runtime.error.mock.calls]).toEqual([[], []]);
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    });
  },
);

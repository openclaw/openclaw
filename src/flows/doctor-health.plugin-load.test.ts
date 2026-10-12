import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { doctorCommand } from "../commands/doctor.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import * as pluginSourceFiles from "../plugins/plugin-source-file.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const { mocks } = await import("./doctor-health.test-support.js");

vi.mock("../plugins/plugin-source-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-source-file.js")>()),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { failure: "ENOSPC", update: "standalone" },
  { failure: "ENOSPC", update: "in-progress" },
])(
  "reports a plugin $failure during $update Doctor with its corresponding outcome",
  async ({ failure, update }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", update === "in-progress" ? "1" : undefined);
      vi.stubEnv(
        "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
        update === "standalone" ? undefined : "1",
      );
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", undefined);
      const resultPath = state.path("doctor-result.json");
      vi.stubEnv(
        "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
        update === "standalone" ? undefined : resultPath,
      );
      mocks.packageRoot.mockReturnValue(undefined);
      mocks.outro.mockClear();
      mocks.writeUpdatePostInstallDoctorResult.mockClear();
      const id = "doctor-load-fixture";
      const root = state.path("plugin");
      fs.mkdirSync(root);
      const source = path.join(root, "index.cjs");
      fs.writeFileSync(
        source,
        failure === "SyntaxError"
          ? 'throw new SyntaxError("fixture syntax failed");'
          : `module.exports = { id: "${id}", register() {} };`,
      );
      fs.writeFileSync(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({ id, configSchema: { type: "object", properties: {} } }),
      );
      const cfg = {
        plugins: { allow: [id], load: { paths: [root] }, slots: { memory: "none" } },
      };
      mocks.config.mockReturnValue(cfg);
      let failedWrite = false;
      if (failure === "ENOSPC") {
        // Copy-owner tests cover fs-safe translation; Doctor consumes this capture boundary.
        const copy = pluginSourceFiles.copyPluginSourceFile;
        vi.spyOn(pluginSourceFiles, "copyPluginSourceFile").mockImplementation((...args) => {
          if (args[0] === source) {
            failedWrite = true;
            throw Object.assign(new Error("fixture capture write failed"), { code: "ENOSPC" });
          }
          return copy(...args);
        });
      }
      mocks.runContributions.mockImplementation(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const registry = loadPluginRegistryHandle({ config: cfg, cache: false });
          try {
            expect(registry.plugins.find((plugin) => plugin.id === id)).toMatchObject({
              status: "error",
              failurePhase: "load",
              error: expect.stringContaining(
                failure === "ENOSPC" ? "fixture capture write failed" : "fixture syntax failed",
              ),
            });
            if (failure === "ENOSPC") {
              expect(registry.plugins.find((plugin) => plugin.id === id)?.error).toContain(
                "free space on the filesystem used by the plugin load and rerun Doctor",
              );
            }
          } finally {
            await disposePluginRegistryInstances(registry);
          }
        }
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await doctorCommand(runtime, { nonInteractive: true });
      expect(failedWrite).toBe(failure === "ENOSPC");
      if (update === "standalone") {
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      } else {
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
          resultPath,
          result: expect.objectContaining({
            status: "ok",
            warnings: [expect.stringContaining(source)],
          }),
        });
      }
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("[error] core/doctor/workspace-status"),
      );
      const output = runtime.error.mock.calls.flat().join("\n");
      expect(output).toContain(id);
      expect(output).toContain(failure);
      expect(output).toContain(source);
      expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
      // A later invocation must not inherit released inspection failures.
      mocks.runContributions.mockResolvedValue(undefined);
      runtime.exit.mockClear();
      runtime.error.mockClear();
      await doctorCommand(runtime, { nonInteractive: true });
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    });
  },
);

import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { doctorCommand } from "../commands/doctor.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const { mocks } = await import("./doctor-health.test-support.js");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { failure: "ENOSPC", update: "standalone" },
  { failure: "SyntaxError", update: "standalone" },
  { failure: "ENOSPC", update: "in-progress" },
  { failure: "ENOSPC", update: "parent-only" },
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
      const write = fs.writeFileSync;
      if (failure === "ENOSPC") {
        vi.spyOn(fs, "writeFileSync").mockImplementation((target, ...args) => {
          if (path.basename(String(target)) === "index.cjs" && String(target) !== source) {
            failedWrite = true;
            throw Object.assign(new Error("fixture capture write failed"), { code: "ENOSPC" });
          }
          return write(target, ...args);
        });
      }
      mocks.runContributions.mockImplementation(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const registry = loadPluginRegistryHandle({ config: cfg, cache: false });
          try {
            expect(registry.plugins.find((plugin) => plugin.id === id)).toMatchObject({
              status: "error",
              failurePhase: "load",
            });
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

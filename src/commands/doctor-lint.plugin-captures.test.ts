import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "../plugins/plugin-instance-module-loader.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCliInProcess } from "./doctor-lint-runner.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({ checks: vi.fn() }));
vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: mocks.checks,
}));

it("keeps native plugin captures alive after Doctor retires its private state snapshot", async () => {
  await withOpenClawTestState({ prefix: "doctor-plugin-captures-" }, async (state) => {
    await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
    openOpenClawStateDatabase();
    await closeOpenClawStateDatabaseAsync();
    const plugin = state.path("channel-plugin");
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(plugin, "package.json"), '{"name":"channel-fixture"}');
    fs.writeFileSync(path.join(plugin, "README.md"), "channel companion");
    fs.writeFileSync(path.join(plugin, "addon.node"), "synthetic native bytes");
    fs.writeFileSync(
      path.join(plugin, "index.cjs"),
      `const fs = require("node:fs");
       const path = require("node:path");
       exports.read = () => {
         const native = fs.realpathSync(path.join(__dirname, "addon.node"));
         return fs.readFileSync(path.join(path.dirname(native), "README.md"), "utf8");
       };`,
    );
    const cache = createPluginCache();
    const instances: PluginInstance[] = [];
    const load = () => {
      const instance = new PluginInstance("channel-fixture");
      instances.push(instance);
      const source = path.join(plugin, "index.cjs");
      bindPluginInstanceModuleLoader({ instance, origin: "config", source, rootDir: plugin });
      return instance.loadModule(source) as { read(): string };
    };
    let first: ReturnType<typeof load> | undefined;
    let privateState = "";
    let snapshotHasCaptures = false;
    mocks.checks.mockResolvedValue([
      {
        id: "core/doctor/runtime-tool-schemas",
        kind: "core",
        description: "Inspect channel plugin",
        async detect() {
          privateState = process.env.OPENCLAW_STATE_DIR!;
          first = load();
          expect(first.read()).toBe("channel companion");
          snapshotHasCaptures = fs.existsSync(path.join(privateState, "tmp", "plugin-captures"));
          return [];
        },
      },
    ]);
    clearHealthChecksForTest();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await withPluginCache(cache, async () => {
        expect(
          await runDoctorLintCliInProcess(createTestRuntime(), {
            json: true,
            onlyIds: ["core/doctor/runtime-tool-schemas"],
          }),
        ).toBe(0);
        expect(privateState).not.toBe(state.stateDir);
        expect(fs.existsSync(privateState)).toBe(false);
        expect(first?.read()).toBe("channel companion");
        expect(snapshotHasCaptures).toBe(false);
        // Channel setup loads again after the inspection snapshot has retired.
        expect(load().read()).toBe("channel companion");
      });
    } finally {
      stdout.mockRestore();
      for (const instance of instances) {
        await instance.dispose();
      }
      await retirePluginCache(cache);
      clearHealthChecksForTest();
    }
  });
});

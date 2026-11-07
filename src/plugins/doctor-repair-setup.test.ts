import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { runDoctorRepairSequence } from "../commands/doctor/repair-sequencing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { writeArtifacts } from "./public-surface.test-support.js";

const installRepair = vi.hoisted(() => vi.fn());
// mock-isolation: The installer supplies the completed repair result; plugin discovery,
// Doctor preparation, setup loading, auto-enable, and the repair sequence remain real.
vi.mock("../commands/doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: installRepair,
}));

it("prepares setup after Doctor config repair before auto-enabling a repaired plugin", async () => {
  expect(isMainThread, "Doctor setup proof requires the plugins fork lane").toBe(true);
  await withOpenClawTestState(
    { label: "doctor-repair-setup", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const id = "doctor-setup-owner";
      const rootDir = state.path("plugin");
      const setupSource = path.join(rootDir, "setup-api.cjs");
      const doctorSource = path.join(rootDir, "doctor-contract-api.cjs");
      writeArtifacts(rootDir, {
        "package.json": {
          name: "@example/doctor-setup-owner",
          version: "1.0.0",
          type: "commonjs",
          openclaw: { extensions: ["./index.cjs"], setupEntry: "./setup-api.cjs" },
        },
        "openclaw.plugin.json": {
          id,
          setup: { requiresRuntime: true },
          doctorContract: { configRepair: true },
          configSchema: { type: "object", properties: {} },
        },
        "index.cjs": 'throw new Error("Doctor must not load plugin runtime");',
        "doctor-contract-api.cjs": "module.exports = { legacyConfigRules: [] };",
        "setup-api.cjs": `module.exports = { id: "doctor-setup-owner", register(api) {
          api.registerAutoEnableProbe(() => "setup fixture configured");
        } };`,
      });
      const config: OpenClawConfig = {
        plugins: {
          allow: [id],
          entries: { [id]: { config: {} } },
          load: { paths: [rootDir] },
        },
      };
      await using cache = createPluginCache();
      await withPluginCache(cache, () =>
        withPluginGenerationSourceCustody(async () => {
          const snapshot = loadPluginMetadataSnapshot({ config, env: state.env });
          expect(snapshot.plugins).toMatchObject([{ id, setupSource }]);
          expect(cache.setupModules.size).toBe(0);
          const repairNote = "Completed configured plugin install repair.";
          installRepair.mockImplementationOnce(async () => {
            // The earlier configRepair preparation succeeded but did not prepare setup.
            expect(cache.setupModules.has(`setup:${id}:${doctorSource}:no-state-operations`)).toBe(
              true,
            );
            expect(cache.setupModules.has(`setup:${id}:${setupSource}`)).toBe(false);
            return { changes: [repairNote], warnings: [], records: {} };
          });
          const result = await runDoctorRepairSequence({
            state: { cfg: config, candidate: config, pendingChanges: false, fixHints: [] },
            doctorFixCommand: "openclaw doctor --fix",
            env: state.env,
            pluginMetadataSnapshotState: { current: snapshot },
            runWithPluginMetadataSnapshot: (scope, run) =>
              withPluginMetadataSnapshotScope(snapshot, run, { ...scope, env: state.env }),
          });
          expect(installRepair).toHaveBeenCalledOnce();
          expect(result.changeNotes).toContain(repairNote);
          expect(result.state.candidate.plugins?.entries?.[id]?.enabled).toBe(true);
          expect(result.state.pendingChanges).toBe(true);
          expect(result.configChangeNotes.join("\n")).toContain("setup fixture configured");
          expect(cache.setupModules.has(`setup:${id}:${setupSource}`)).toBe(true);
        }),
      );
    },
  );
});

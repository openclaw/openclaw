import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineLegacyJsonStateMigration } from "../plugin-sdk/runtime-doctor-migrations.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { detectLegacyStateMigrations } from "./state-migrations.doctor.js";
import { autoMigrateLegacyPluginDoctorState } from "./state-migrations.plugin-doctor.js";

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorStateMigrationEntries: () => [{ pluginId: "fixture", migration }],
  };
});

const migration = defineLegacyJsonStateMigration({
  id: "fixture-json",
  label: "Fixture legacy state",
  resolvePath: (stateDir) => path.join(stateDir, "legacy.json"),
  parse: (value) => (Array.isArray(value) ? value : null),
  namespace: "legacy",
  maxEntries: 10,
  describeEntries: () => ({
    preview: ["Fixture legacy state"],
    change: () => "Imported fixture legacy state",
  }),
  toRows: (values) => values.map((value, index) => ({ key: String(index), value })),
});
afterEach(() => vi.restoreAllMocks());

describe.each(["detection", "migration"] as const)("legacy JSON %s", (phase) => {
  it.each(["EACCES", "unrecognized shape"])(
    "reports %s without importing or archiving the source",
    async (fault) =>
      withOpenClawTestState({ label: "legacy-json-doctor" }, async (state) => {
        const sourcePath = state.statePath("legacy.json");
        const source = "{}";
        await fs.writeFile(sourcePath, source, "utf8");
        const readFile = fs.readFile.bind(fs);
        let sourceReads = 0;
        vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
          if (filePath !== sourcePath) {
            return readFile(filePath, options);
          }
          // Let detection succeed, then fail the direct migration read.
          if (++sourceReads === 1 && phase === "migration") {
            return '[{"disabled":true}]';
          }
          if (fault === "EACCES") {
            throw Object.assign(new Error(`${fault}: read ${sourcePath}`), { code: fault });
          }
          return readFile(filePath, options);
        });

        let warnings: string[];
        if (phase === "detection") {
          const detected = await detectLegacyStateMigrations({
            cfg: {},
            env: state.env,
            homedir: () => state.home,
            pluginSessionStoreAgentIds: [],
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          });
          expect(detected.pluginPlans?.hasLegacy).toBe(false);
          warnings = detected.warnings;
        } else {
          const result = await autoMigrateLegacyPluginDoctorState({
            config: {},
            env: state.env,
            homedir: () => state.home,
          });
          expect(result.changes).toEqual([]);
          expect(sourceReads).toBe(2);
          warnings = result.warnings;
        }

        const action = phase === "detection" ? "detecting" : "migrating";
        const warning = expect.stringMatching(
          new RegExp(`^Failed ${action} Fixture legacy state:.*EACCES`),
        );
        expect(warnings).toEqual(fault === "EACCES" ? [warning] : []);
        await expect(readFile(sourcePath, "utf8")).resolves.toBe(source);
        await expect(fs.stat(`${sourcePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
      }),
  );
});

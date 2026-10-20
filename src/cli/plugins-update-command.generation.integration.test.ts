import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { listPluginDoctorStateMigrationEntries } from "../plugins/doctor-contract-registry.js";
import { installPluginFromNpmSpec } from "../plugins/install.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { runPluginUpdateCommand } from "./plugins-update-command.js";

vi.mock("../plugins/update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/update.js")>()),
  updateNpmInstalledPlugins: vi.fn(),
}));
vi.mock("../plugins/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install.js")>()),
  installPluginFromNpmSpec: vi.fn(),
}));
const actualUpdate =
  await vi.importActual<typeof import("../plugins/update.js")>("../plugins/update.js");
// mock-isolation: This offline update owns no Gateway or network connection.
vi.mock("./plugins-lifecycle-client.js", () => ({
  resolvePluginLifecycleGateway: async () => null,
}));
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
    throw new Error(`Unexpected exit ${code}`);
  });
});

function writeJson(root: string, name: string, value: unknown) {
  fs.writeFileSync(path.join(root, name), JSON.stringify(value));
}

function writePackage(installPath: string, version: string, doctorContract?: object) {
  fs.mkdirSync(installPath, { recursive: true });
  writeJson(installPath, "package.json", {
    name: "@openclaw/codex",
    version,
    type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  });
  fs.writeFileSync(path.join(installPath, "index.mjs"), "export default {};\n");
  writeJson(installPath, "openclaw.plugin.json", {
    id: "codex",
    configSchema: { type: "object" },
    ...(doctorContract ? { doctorContract } : {}),
  });
}

it("publishes the replacement Doctor config when a ClawHub update reuses the installed path", async () => {
  await withOpenClawTestState(
    { label: "codex-update-generation", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const installPath = state.statePath("extensions", "codex");
      function writeDoctorPackage(version: string) {
        const actions = [
          { id: "codex-app-server-sidecars-to-plugin-state" },
          ...(version === "2026.9.7" ? [{ id: "codex-native-task-assignments" }] : []),
          {
            id: "codex-app-server-orphaned-session-bindings",
            doctorOnly: true,
            phase: "after-session-repair",
          },
        ];
        writePackage(installPath, version, { configRepair: true, stateMigrations: actions });
        fs.writeFileSync(
          path.join(installPath, "doctor-contract-api.mjs"),
          `
          export function normalizeCompatibilityConfig({cfg}) {
            const config = structuredClone(cfg);
            config.plugins.entries.codex.config.generation = ${JSON.stringify(version)};
            return { config, changes: ["Updated plugin settings."] };
          }
          export const stateMigrations = ${JSON.stringify(actions)}.map(action => ({
            ...action, label: action.id, detectLegacyState() { return null; },
            migrateLegacyState() { return { changes: [], warnings: [] }; },
          }));
        `,
        );
      }
      writeDoctorPackage("2026.9.6");
      const config = {
        plugins: {
          allow: ["codex"],
          entries: { codex: { enabled: true, config: { generation: "2026.9.6" } } },
        },
      };
      await state.writeConfig(config);
      const previous: PluginInstallRecord = {
        source: "clawhub",
        clawhubPackage: "@openclaw/codex",
        clawhubUrl: "https://clawhub.ai",
        installPath,
        version: "2026.9.6",
      };
      await seedInstalledPluginIndex({ codex: previous }, { config, env: state.env });
      // Doctor/config inspection can load the installed package before the updater replaces it.
      expect(
        listPluginDoctorStateMigrationEntries({ config, env: state.env, pluginIds: ["codex"] }),
      ).toHaveLength(2);
      const next = { ...previous, version: "2026.9.7" };
      vi.mocked(updateNpmInstalledPlugins).mockImplementation(async (params) => {
        writeDoctorPackage("2026.9.7");
        return {
          config: {
            ...params.config,
            plugins: { ...params.config.plugins, installs: { codex: next } },
          },
          changed: true,
          outcomes: [
            { pluginId: "codex", status: "updated", message: "Updated codex to 2026.9.7." },
          ],
        };
      });
      await runPluginUpdateCommand({ ids: ["codex"], opts: {} });
      expect(
        JSON.parse(fs.readFileSync(state.configPath, "utf8")).plugins.entries.codex.config,
      ).toEqual({ generation: "2026.9.7" });
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual({
        codex: next,
      });
      expect(defaultRuntime.log).toHaveBeenCalledWith(
        "Updates saved; they will load on the next Gateway start.",
      );
    },
  );
});

it.each([
  { ids: ["codex"], all: false, expected: `@openclaw/codex@${VERSION}` },
  { ids: [], all: true, expected: `@openclaw/codex@${VERSION}` },
  { ids: ["@openclaw/codex@2026.9.5"], all: false, expected: "@openclaw/codex@2026.9.5" },
])("resolves standalone plugin updates against the host cohort ($ids, all=$all)", async (test) => {
  await withOpenClawTestState(
    { label: "plugin-update-cohort", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const installPath = state.statePath("extensions", "codex");
      writePackage(installPath, "2026.9.5");
      const config = {
        update: { channel: "stable" as const },
        plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
      };
      await state.writeConfig(config);
      await seedInstalledPluginIndex(
        {
          codex: {
            source: "npm",
            spec: "@openclaw/codex",
            resolvedName: "@openclaw/codex",
            resolvedSpec: "@openclaw/codex@2026.9.5",
            version: "2026.9.5",
            resolvedVersion: "2026.9.5",
            installPath,
          },
        },
        { config, env: state.env },
      );
      vi.mocked(installPluginFromNpmSpec).mockResolvedValue({
        ok: true,
        pluginId: "codex",
        targetDir: installPath,
        version: VERSION,
        extensions: ["./index.mjs"],
      });

      vi.mocked(updateNpmInstalledPlugins).mockImplementation(
        actualUpdate.updateNpmInstalledPlugins,
      );
      await runPluginUpdateCommand({ ids: test.ids, opts: { all: test.all, dryRun: true } });

      expect(installPluginFromNpmSpec).toHaveBeenLastCalledWith(
        expect.objectContaining({ spec: test.expected, dryRun: true }),
      );
    },
  );
});

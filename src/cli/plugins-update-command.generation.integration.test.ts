import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig as Config } from "../config/types.js";
import type { PluginInstallRecord as Install } from "../config/types.plugins.js";
import { listPluginDoctorStateMigrationEntries } from "../plugins/doctor-contract-registry.js";
import { installPluginFromNpmSpec } from "../plugins/install.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import {
  withOpenClawTestState,
  type OpenClawTestState as State,
} from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { runPluginUpdateCommand } from "./plugins-update-command.js";

const packageName = "@openclaw/codex";
type PluginFixture = { state: State; config: Config; previous: Install; root: string };

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

function writePackage(root: string, version: string, doctor = false) {
  fs.mkdirSync(root, { recursive: true });
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  write("package.json", {
    name: packageName,
    version,
    type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  });
  fs.writeFileSync(path.join(root, "index.mjs"), "export default {};\n");
  const actions = [
    { id: "codex-app-server-sidecars-to-plugin-state" },
    ...(version === "2026.9.7" ? [{ id: "codex-native-task-assignments" }] : []),
    {
      id: "codex-app-server-orphaned-session-bindings",
      doctorOnly: true,
      phase: "after-session-repair",
    },
  ];
  write("openclaw.plugin.json", {
    id: "codex",
    configSchema: { type: "object" },
    ...(doctor ? { doctorContract: { configRepair: true, stateMigrations: actions } } : {}),
  });
  if (doctor) {
    fs.writeFileSync(
      path.join(root, "doctor-contract-api.mjs"),
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
}

function withInstalledPlugin(
  source: "clawhub" | "npm",
  run: (fixture: PluginFixture) => Promise<void>,
) {
  return withOpenClawTestState(
    { label: "plugin-update", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const root = state.statePath("extensions", "codex");
      const doctor = source === "clawhub";
      const version = doctor ? "2026.9.6" : "2026.9.5";
      writePackage(root, version, doctor);
      const entry = { enabled: true, ...(doctor ? { config: { generation: version } } : {}) };
      const config: Config = {
        ...(doctor ? {} : { update: { channel: "stable" } }),
        plugins: { allow: ["codex"], entries: { codex: entry } },
      };
      const record: Install = {
        source,
        version,
        installPath: root,
        ...(doctor
          ? { clawhubPackage: packageName, clawhubUrl: "https://clawhub.ai" }
          : {
              spec: packageName,
              resolvedName: packageName,
              resolvedSpec: "@openclaw/codex@2026.9.5",
              resolvedVersion: version,
            }),
      };
      await state.writeConfig(config);
      await seedInstalledPluginIndex({ codex: record }, { config, env: state.env });
      await run({ state, config, previous: record, root });
    },
  );
}

it("publishes the replacement Doctor config when a ClawHub update reuses the installed path", async () => {
  await withInstalledPlugin("clawhub", async ({ state, config, previous, root }) => {
    // Load the old contract before replacement to exercise generation invalidation.
    expect(
      listPluginDoctorStateMigrationEntries({ config, env: state.env, pluginIds: ["codex"] }),
    ).toHaveLength(2);
    const next = { ...previous, version: "2026.9.7" };
    vi.mocked(updateNpmInstalledPlugins).mockImplementation(async (params) => {
      writePackage(root, "2026.9.7", true);
      return {
        config: {
          ...params.config,
          plugins: { ...params.config.plugins, installs: { codex: next } },
        },
        changed: true,
        outcomes: [{ pluginId: "codex", status: "updated", message: "Updated codex to 2026.9.7." }],
      };
    });
    await runPluginUpdateCommand({ ids: ["codex"], opts: {} });
    expect(
      JSON.parse(fs.readFileSync(state.configPath, "utf8")).plugins.entries.codex.config,
    ).toEqual({ generation: "2026.9.7" });
    expect(await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env })).toEqual({
      codex: next,
    });
    expect(defaultRuntime.log).toHaveBeenCalledWith(
      "Updates saved; they will load on the next Gateway start.",
    );
  });
});

it.each([
  { ids: ["codex"], all: false, expected: `@openclaw/codex@${VERSION}` },
  { ids: [], all: true, expected: `@openclaw/codex@${VERSION}` },
  { ids: ["@openclaw/codex@2026.9.5"], all: false, expected: "@openclaw/codex@2026.9.5" },
])("resolves standalone plugin updates against the host cohort ($ids, all=$all)", async (test) => {
  await withInstalledPlugin("npm", async ({ root }) => {
    vi.mocked(installPluginFromNpmSpec).mockResolvedValue({
      ok: true,
      pluginId: "codex",
      targetDir: root,
      version: VERSION,
      extensions: ["./index.mjs"],
    });
    vi.mocked(updateNpmInstalledPlugins).mockImplementation(actualUpdate.updateNpmInstalledPlugins);
    await runPluginUpdateCommand({ ids: test.ids, opts: { all: test.all, dryRun: true } });
    expect(installPluginFromNpmSpec).toHaveBeenLastCalledWith(
      expect.objectContaining({ spec: test.expected, dryRun: true }),
    );
  });
});

// Doctor plugin registry tests cover plugin registry checks and repair diagnostics.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as pluginInstall from "../plugins/install.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { markRetainedManagedNpmInstall } from "../plugins/managed-npm-retention.js";
import { isTrustedOfficialPluginInstallRecord } from "../plugins/official-external-install-records.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  detectPluginRegistryHealthIssues,
  maybeRepairPluginRegistryState,
  pluginRegistryIssueToHealthFinding,
  pluginRegistryIssueToRepairEffect,
} from "./doctor-plugin-registry.js";
import {
  readRequiredPersistedInstalledPluginIndex,
  hermeticEnv,
  createCandidate,
  createBundledCandidate,
  createManagedNpmPlugin,
  createCurrentIndex,
  createCurrentIndexWithNpmRecord,
  createCurrentIndexWithPathRecord,
  expectedPluginIndexRecord,
} from "./doctor-plugin-registry.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  detectConfiguredPluginInstallHealthIssues,
  repairMissingPluginInstallsForIds,
} from "./doctor/shared/missing-configured-plugin-install.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(note).mockReset();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-doctor-plugin-registry", tempDirs);
}

function runDoctor(
  params: Omit<Parameters<typeof maybeRepairPluginRegistryState>[0], "prompter">,
  shouldRepair = true,
) {
  return maybeRepairPluginRegistryState({ ...params, prompter: { shouldRepair } });
}

async function writeNpmIndex(
  stateDir: string,
  packageDir: string,
  pluginId: string,
  packageName: string,
  version: string,
) {
  await writePersistedInstalledPluginIndex(
    createCurrentIndexWithNpmRecord({ pluginId, packageName, packageDir, version }),
    { stateDir },
  );
}

async function createPeerFixture(id = "codex", packageName = "codex-plugin") {
  const stateDir = makeTempDir();
  const managed = createManagedNpmPlugin({
    stateDir,
    id,
    packageName,
    version: "2026.5.3",
    peerDependencies: id === "codex" ? { openclaw: ">=2026.5.3" } : undefined,
  });
  await writeNpmIndex(stateDir, managed.packageDir, id, packageName, "2026.5.3");
  return { managed, params: { stateDir, env: hermeticEnv(), config: {} } };
}

function createBundledNpmFixture(options: { version?: string; packageLock?: boolean } = {}) {
  const stateDir = makeTempDir();
  const bundledDir = path.join(stateDir, "bundled", "bundled-demo");
  fs.mkdirSync(bundledDir, { recursive: true });
  const managed = createManagedNpmPlugin({
    stateDir,
    id: "bundled-demo",
    packageName: "@openclaw/bundled-demo",
    version: options.version ?? "2026.5.2",
    packageLock: options.packageLock,
  });
  return {
    stateDir,
    bundledDir,
    managed,
    params: {
      stateDir,
      candidates: [
        createBundledCandidate({
          rootDir: bundledDir,
          id: "bundled-demo",
          packageName: "@openclaw/bundled-demo",
          version: "2026.5.3",
        }),
      ],
      env: hermeticEnv(),
      config: {
        plugins: {
          allow: ["bundled-demo"],
          entries: { "bundled-demo": { enabled: true, config: {} } },
        },
      },
    },
  };
}

async function createStaleLocalFixture() {
  const stateDir = makeTempDir();
  const bundledDir = path.join(stateDir, "current", "dist", "extensions", "discord");
  const staleDir = path.join(stateDir, "old-checkout", "dist", "extensions", "discord");
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.mkdirSync(staleDir, { recursive: true });
  createCandidate(staleDir, "discord");
  await writePersistedInstalledPluginIndex(
    createCurrentIndexWithPathRecord({
      pluginId: "discord",
      installPath: staleDir,
      version: "2026.5.4-beta.3",
    }),
    { stateDir },
  );
  return {
    stateDir,
    bundledDir,
    staleDir,
    params: {
      stateDir,
      candidates: [
        createBundledCandidate({
          rootDir: bundledDir,
          id: "discord",
          packageName: "@openclaw/discord",
          version: "2026.5.20-beta.1",
        }),
      ],
      env: hermeticEnv(),
      config: {
        plugins: { allow: ["discord"], entries: { discord: { enabled: true, config: {} } } },
      },
    },
  };
}

describe("maybeRepairPluginRegistryState", () => {
  it("does not warn for uninitialized registry state", async () => {
    const stateDir = makeTempDir();
    await expect(
      detectPluginRegistryHealthIssues({
        stateDir,
        env: hermeticEnv(),
        config: {},
        prompter: { shouldRepair: false },
      }),
    ).resolves.toEqual([]);
  });

  it("maps stale managed npm bundled plugin shadows to structured findings", async () => {
    const { stateDir, managed, params } = createBundledNpmFixture();
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });

    const issues = await detectPluginRegistryHealthIssues({
      ...params,
      prompter: { shouldRepair: false },
    });

    const staleIssue = issues.find((issue) => issue.kind === "stale-managed-npm-bundled-plugin");
    expect(staleIssue).toMatchObject({
      kind: "stale-managed-npm-bundled-plugin",
      pluginId: "bundled-demo",
      packageName: "@openclaw/bundled-demo",
      packageDir: managed.packageDir,
      version: "2026.5.2",
    });
    expect(pluginRegistryIssueToHealthFinding(staleIssue!)).toMatchObject({
      checkId: "core/doctor/plugin-registry",
      severity: "warning",
      path: managed.packageDir,
      target: "bundled-demo",
    });
    expect(pluginRegistryIssueToRepairEffect(staleIssue!)).toEqual({
      kind: "package",
      action: "would-remove-stale-managed-npm-bundled-plugin",
      target: managed.packageDir,
      dryRunSafe: false,
    });
    await runDoctor(params, false);
    const notes = vi.mocked(note).mock.calls.join("\n");
    expect(notes).toContain("Managed npm plugin packages shadow bundled plugins");
    expect(notes).toContain("@openclaw/bundled-demo@2026.5.2");
    expect(fs.existsSync(managed.packageDir)).toBe(true);
  });

  it("maps stale local bundled install records to structured findings", async () => {
    const { staleDir, params } = await createStaleLocalFixture();

    const issues = await detectPluginRegistryHealthIssues({
      ...params,
      prompter: { shouldRepair: false },
    });

    const staleIssue = issues.find(
      (issue) => issue.kind === "stale-local-bundled-plugin-install-record",
    );
    expect(staleIssue).toEqual({
      kind: "stale-local-bundled-plugin-install-record",
      pluginId: "discord",
      stalePath: staleDir,
    });
    expect(pluginRegistryIssueToHealthFinding(staleIssue!)).toMatchObject({
      checkId: "core/doctor/plugin-registry",
      severity: "warning",
      path: staleDir,
      target: "discord",
    });
    await runDoctor(params, false);
    const notes = vi.mocked(note).mock.calls.join("\n");
    expect(notes).toContain("Local bundled plugin install records shadow bundled plugins");
    expect(notes).toContain("discord");
    expect(notes).toContain(staleDir);
    const persisted = await readRequiredPersistedInstalledPluginIndex(params.stateDir);
    expect(persisted.installRecords).toHaveProperty("discord");
  });

  it("refreshes an existing registry during repair", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });
    const candidate = createCandidate(pluginDir);
    const prompter = createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { repair: true, nonInteractive: true },
    });

    const nextConfig = await maybeRepairPluginRegistryState({
      stateDir,
      candidates: [candidate],
      env: hermeticEnv(),
      config: {},
      prompter,
    });

    expect(nextConfig).toStrictEqual({ config: {}, pluginInventoryChanged: true });
    const persisted = await readRequiredPersistedInstalledPluginIndex(stateDir);
    expect(persisted.refreshReason).toBe("migration");
    expect(persisted.plugins).toStrictEqual([
      expectedPluginIndexRecord({
        pluginId: "demo",
        rootDir: pluginDir,
        origin: "global",
      }),
    ]);
    await expect(
      maybeRepairPluginRegistryState({
        stateDir,
        candidates: [candidate],
        env: hermeticEnv(),
        config: {},
        prompter,
      }),
    ).resolves.toStrictEqual({ config: {} });
  });

  it("reports the supported manual recovery for invalid persisted records", async () => {
    const stateDir = makeTempDir();
    const config: OpenClawConfig = {};
    const installRecordsJson = '{"__proto__":{"source":"bogus"}}';
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        // Build the JSON text manually so the __proto__ key stays an own property.
        const valueJson =
          '{"revision":123,"index":{"version":1,"hostContractVersion":"test",' +
          '"compatRegistryVersion":"test","migrationVersion":1,"policyHash":"test",' +
          '"generatedAtMs":1,"installRecords":' +
          installRecordsJson +
          ',"plugins":[],"diagnostics":[]}}';
        db.prepare(
          `
            INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms)
            VALUES ('plugins.installedIndex', ?, 123)
          `,
        ).run(valueJson);
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
    );

    await expect(runDoctor({ stateDir, env: hermeticEnv(), config })).resolves.toEqual({ config });

    const notes = vi.mocked(note).mock.calls.join("\n");
    expect(notes).toContain("Stop the Gateway");
    expect(notes).toContain(
      "delete only the config_machine_state row with state_key='plugins.installedIndex'",
    );
    expect(notes).toContain("rerun `openclaw doctor --fix`");
    const row = runOpenClawStateWriteTransaction(
      ({ db }) =>
        db
          .prepare(
            `SELECT value_json, updated_at_ms
               FROM config_machine_state
              WHERE state_key = 'plugins.installedIndex'`,
          )
          .get() as { value_json: string; updated_at_ms: number | bigint },
      { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
    );
    expect(row.updated_at_ms).toBe(123);
    expect(row.value_json).toContain(installRecordsJson);
  });

  it.each([
    ["source-external", "external-demo", false, false, false],
    ["partial catalog-owned external", "google-meet", undefined, true, false],
    [
      "healthy catalog-owned external beside a broken source copy",
      "google-meet",
      undefined,
      false,
      true,
    ],
  ] satisfies Array<[string, string, boolean | undefined, boolean, boolean]>)(
    "preserves installed %s plugin payload and records across repeated doctor repairs",
    async (_name, pluginId, bundledDist, missingEntry, missingSourceEntry) => {
      const stateDir = makeTempDir();
      const packageName = `@openclaw/${pluginId}`;
      const version = "2026.5.2";
      const bundledDir = path.join(stateDir, "source", "extensions", pluginId);
      fs.mkdirSync(bundledDir, { recursive: true });
      const managed = createManagedNpmPlugin({ stateDir, id: pluginId, packageName, version });
      if (!missingEntry) {
        fs.writeFileSync(path.join(managed.packageDir, "index.js"), "export default {};\n");
      }
      fs.writeFileSync(
        path.join(managed.packageDir, "package.json"),
        JSON.stringify({ name: packageName, version, openclaw: { extensions: ["./index.js"] } }),
      );
      const initialIndex = createCurrentIndexWithNpmRecord({
        pluginId,
        packageName,
        packageDir: managed.packageDir,
        version,
      });
      await writePersistedInstalledPluginIndex(initialIndex, { stateDir });
      const candidate = createBundledCandidate({
        rootDir: bundledDir,
        id: pluginId,
        packageName,
        version: "2026.5.3",
        bundledDist,
      });
      if (missingSourceEntry) {
        const manifestPath = path.join(bundledDir, "package.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.openclaw = { ...manifest.openclaw, extensions: ["./missing.js"] };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      const config: OpenClawConfig = {
        plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
      };
      const env = hermeticEnv({
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(bundledDir),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      });
      const install = vi
        .spyOn(pluginInstall, "installPluginFromNpmSpec")
        .mockImplementation(async (options) => {
          const npmResolution = {
            name: packageName,
            version,
            resolvedSpec: `${packageName}@${version}`,
            integrity: "sha512-fixture",
          };
          fs.writeFileSync(path.join(managed.packageDir, "index.js"), "export default {};\n");
          await options.onBeforePluginArtifactCommit?.({
            pluginId,
            stagedArtifactDir: managed.packageDir,
            mode: "update",
            sourceRecord: { source: "npm", spec: options.spec, ...npmResolution },
          });
          return {
            ok: true,
            pluginId,
            targetDir: managed.packageDir,
            extensions: ["./index.js"],
            version,
            npmResolution,
          };
        });
      let expectedRecord = expectDefined(
        initialIndex.installRecords[pluginId],
        "fixture install record",
      );

      for (let pass = 0; pass < 2; pass++) {
        await runDoctor({ stateDir, candidates: [candidate], env, config });
        const issues = await detectConfiguredPluginInstallHealthIssues({ cfg: config, env });
        expect(issues).toEqual(
          missingEntry && pass === 0
            ? [expect.objectContaining({ kind: "repairable-installed-plugin", pluginId })]
            : [],
        );
        const repaired = await repairMissingPluginInstallsForIds({
          cfg: config,
          pluginIds: [pluginId],
          env,
        });

        expect(fs.existsSync(path.join(managed.packageDir, "openclaw.plugin.json"))).toBe(true);
        expect(repaired.changes).toHaveLength(missingEntry && pass === 0 ? 1 : 0);
        expect(repaired.warnings).toEqual([]);
        expect(repaired.outcomes).toBeUndefined();
        if (missingEntry && pass === 0) {
          expect(repaired.records[pluginId]).toMatchObject(expectedRecord);
          expectedRecord = expectDefined(repaired.records[pluginId], "repaired install record");
        }
        expect(repaired.records[pluginId]).toEqual(expectedRecord);
        expect(
          JSON.parse(fs.readFileSync(path.join(managed.npmRoot, "package.json"), "utf8"))
            .dependencies,
        ).toEqual({ [packageName]: version });
        const persisted = await readRequiredPersistedInstalledPluginIndex(stateDir);
        expect(persisted.installRecords[pluginId]).toEqual(expectedRecord);
      }
      expect(install).toHaveBeenCalledTimes(missingEntry ? 1 : 0);
      expect(vi.mocked(note).mock.calls.join("\n")).not.toContain(
        "Removed stale managed npm plugin package",
      );
    },
  );

  it("does not remove retained managed npm packages during stale bundled repair", async () => {
    const { stateDir, managed, params } = createBundledNpmFixture();
    await markRetainedManagedNpmInstall({
      packageDir: managed.packageDir,
      pluginId: "bundled-demo",
      retainedAt: "2026-04-25T00:00:00.000Z",
      reason: "test-retained-generation",
    });
    await writeNpmIndex(
      stateDir,
      managed.packageDir,
      "bundled-demo",
      "@openclaw/bundled-demo",
      "2026.5.2",
    );

    await runDoctor(params);

    expect(fs.existsSync(managed.packageDir)).toBe(true);
    const persisted = await readRequiredPersistedInstalledPluginIndex(stateDir);
    expect(persisted.installRecords["bundled-demo"]).toMatchObject({
      source: "npm",
      installPath: managed.packageDir,
      resolvedName: "@openclaw/bundled-demo",
      resolvedVersion: "2026.5.2",
    });
    expect(vi.mocked(note).mock.calls.join("\n")).not.toContain(
      "Removed stale managed npm plugin package",
    );
  });

  it("removes recovered npm install records when a managed package shadows a bundled plugin", async () => {
    const { stateDir, bundledDir, managed, params } = createBundledNpmFixture({
      version: "2026.5.3",
    });
    await writeNpmIndex(
      stateDir,
      managed.packageDir,
      "bundled-demo",
      "@openclaw/bundled-demo",
      "2026.5.3",
    );

    await runDoctor(params);

    expect(fs.existsSync(managed.packageDir)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(managed.npmRoot, "package.json"), "utf8")),
    ).not.toHaveProperty("dependencies");
    expect(vi.mocked(note).mock.calls.join("\n")).toContain(
      "Removed stale managed npm plugin package",
    );
    const persisted = await readRequiredPersistedInstalledPluginIndex(stateDir);
    expect(Object.keys(persisted.installRecords)).toEqual([]);
    expect(Object.getPrototypeOf(persisted.installRecords)).toBeNull();
    expect(persisted.refreshReason).toBe("migration");
    expect(persisted.plugins).toStrictEqual([
      expectedPluginIndexRecord({
        pluginId: "bundled-demo",
        rootDir: bundledDir,
        origin: "bundled",
        packageName: "@openclaw/bundled-demo",
        packageVersion: "2026.5.3",
      }),
    ]);
  });

  it("removes stale local bundled plugin install records during repair", async () => {
    const { stateDir, bundledDir, params } = await createStaleLocalFixture();

    await runDoctor(params);

    const persisted = await readRequiredPersistedInstalledPluginIndex(stateDir);
    expect(Object.keys(persisted.installRecords)).toEqual([]);
    expect(Object.getPrototypeOf(persisted.installRecords)).toBeNull();
    expect(persisted.refreshReason).toBe("migration");
    expect(persisted.plugins).toStrictEqual([
      expectedPluginIndexRecord({
        pluginId: "discord",
        rootDir: bundledDir,
        origin: "bundled",
        packageName: "@openclaw/discord",
        packageVersion: "2026.5.20-beta.1",
      }),
    ]);
    expect(vi.mocked(note).mock.calls.join("\n")).toContain(
      "Removed stale local bundled plugin install record",
    );
  });

  it("removes stale managed npm packages from the package lock during repair", async () => {
    const { stateDir, managed, params } = createBundledNpmFixture({ packageLock: true });
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });

    await runDoctor(params);

    const packageLock = JSON.parse(
      fs.readFileSync(path.join(managed.npmRoot, "package-lock.json"), "utf8"),
    );
    expect(packageLock.packages[""].dependencies).toEqual({ "other-plugin": "1.0.0" });
    expect(packageLock.packages).not.toHaveProperty("node_modules/@openclaw/bundled-demo");
    expect(packageLock.dependencies).not.toHaveProperty("@openclaw/bundled-demo");
    expect(packageLock.dependencies).toHaveProperty("other-plugin");
  });

  it("repairs managed npm openclaw peer links during registry repair", async () => {
    const { managed, params } = await createPeerFixture();
    await runDoctor(params);

    const linkPath = path.join(managed.packageDir, "node_modules", "openclaw");
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(process.cwd()));
    expect(vi.mocked(note).mock.calls.join("\n")).toContain("Repaired OpenClaw host peer link");
  });

  it("warns about broken managed npm openclaw peer links without repairing them", async () => {
    const { managed, params } = await createPeerFixture();
    await runDoctor(params, false);

    const linkPath = path.join(managed.packageDir, "node_modules", "openclaw");
    const notes = vi.mocked(note).mock.calls.join("\n");
    expect(notes).toContain("Managed npm OpenClaw host peer links need repair");
    expect(notes).toContain("codex-plugin");
    expect(notes).toContain("openclaw doctor --fix");
    expect(fs.existsSync(linkPath)).toBe(false);
  });

  it("reports an unreadable managed npm package without aborting doctor", async () => {
    const { managed, params } = await createPeerFixture("broken", "broken-plugin");
    fs.writeFileSync(path.join(managed.packageDir, "package.json"), "{", "utf8");
    await expect(runDoctor(params, false)).resolves.toEqual({ config: {} });

    const notes = vi.mocked(note).mock.calls.join("\n");
    expect(notes).toContain("Managed npm plugin packages could not be inspected");
    expect(notes).toContain("broken-plugin");
  });
});

describe("doctor official plugin provenance", () => {
  const pluginId = "diagnostics-otel";
  const packageName = "@openclaw/diagnostics-otel";
  const legacyRecord: PluginInstallRecord = {
    source: "clawhub",
    spec: `clawhub:${packageName}@2026.7.2`,
  };

  async function createProvenanceFixture(record = legacyRecord) {
    const stateDir = makeTempDir();
    const installRecords = { [pluginId]: record };
    await writePersistedInstalledPluginIndex(
      { ...createCurrentIndex(), installRecords },
      { stateDir },
    );
    return {
      stateDir,
      installRecords,
      params: { stateDir, candidates: [], env: hermeticEnv(), config: {} },
    };
  }

  it("persists missing ClawHub authority from a proven official record", async () => {
    const { stateDir, params } = await createProvenanceFixture();
    expect(
      isTrustedOfficialPluginInstallRecord({ pluginId, packageName, record: legacyRecord }),
    ).toBe(false);

    await runDoctor(params);

    const persisted = await readRequiredPersistedInstalledPluginIndex(stateDir);
    const record = persisted.installRecords[pluginId]!;
    expect(record).toEqual({
      ...legacyRecord,
      clawhubUrl: "https://clawhub.ai",
      clawhubChannel: "official",
    });
    expect(isTrustedOfficialPluginInstallRecord({ pluginId, packageName, record })).toBe(true);

    await runDoctor(params);
    expect((await readRequiredPersistedInstalledPluginIndex(stateDir)).installRecords).toEqual(
      persisted.installRecords,
    );
  });

  it.each([
    { name: "path source", record: { ...legacyRecord, source: "path" } },
    { name: "local source path", record: { ...legacyRecord, sourcePath: "/tmp/local-plugin" } },
    { name: "missing URL only", record: { ...legacyRecord, clawhubChannel: "official" } },
    { name: "missing channel only", record: { ...legacyRecord, clawhubUrl: "https://clawhub.ai" } },
    { name: "custom host", record: { ...legacyRecord, clawhubUrl: "https://example.invalid" } },
    { name: "community channel", record: { ...legacyRecord, clawhubChannel: "community" } },
    { name: "conflicting identity", record: { ...legacyRecord, resolvedName: "@vendor/acpx" } },
    {
      name: "npm-only catalog identity",
      record: { source: "clawhub", spec: "clawhub:@openclaw/acpx" },
    },
    { name: "unlisted spec", record: { source: "clawhub", spec: "clawhub:@vendor/acpx" } },
  ] satisfies Array<{ name: string; record: PluginInstallRecord }>)(
    "preserves unproven $name for reinstall instead of inventing authority",
    async ({ record }) => {
      const { stateDir, installRecords, params } = await createProvenanceFixture(record);
      await runDoctor(params);
      expect((await readRequiredPersistedInstalledPluginIndex(stateDir)).installRecords).toEqual(
        installRecords,
      );
    },
  );

  it("leaves legacy authority untouched without repair", async () => {
    const { stateDir, installRecords, params } = await createProvenanceFixture();
    await runDoctor(params, false);
    expect((await readRequiredPersistedInstalledPluginIndex(stateDir)).installRecords).toEqual(
      installRecords,
    );
  });
});

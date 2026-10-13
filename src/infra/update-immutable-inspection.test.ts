import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { resolvePluginSourceCaptureFallbackPrefix } from "../plugins/plugin-source-capture-path.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import {
  formatImmutableUpdateCoverage,
  inspectImmutableUpdateCoverage,
} from "./update-immutable-inspection.js";
import type { ImmutableInstallRecord } from "./update-immutable-install-schema.js";

const mocks = vi.hoisted(() => ({ readRecord: vi.fn(), readService: vi.fn() }));

vi.mock("./update-immutable-install-record.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-immutable-install-record.js")>()),
  readImmutableInstallRecord: mocks.readRecord,
}));
vi.mock("./update-immutable-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-immutable-service.js")>()),
  readImmutableService: mocks.readService,
}));
vi.mock("./update-immutable-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-immutable-layout.js")>()),
  // Privileged installation admission is independent of read-only inventory.
  assertImmutableDescriptorCurrent: () => {},
  directoryIdentity: () => "1:3",
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const currentSha = "a".repeat(40);
const preparedSha = "b".repeat(40);

afterEach(async () => {
  clearPluginDoctorContractRegistryCache();
  await waitForPluginCacheRetirement();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function write(file: string, contents: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function database(file: string, version: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openNodeSqliteDatabase(file);
  db.exec(`PRAGMA user_version=${version}; CREATE TABLE evidence(value TEXT);`);
  db.prepare("INSERT INTO evidence VALUES (?)").run("synthetic preserved history");
  return db;
}

function fixture() {
  clearPluginDoctorContractRegistryCache();
  const root = fs.realpathSync(dirs.make("immutable-inspection-"));
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  const main = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  const external = path.join(root, "external", "openclaw-agent.sqlite");
  const retained = path.join(root, "retained", "openclaw-agent.sqlite");
  const absentConfigured = path.join(root, "absent-configured", "openclaw-agent.sqlite");
  const absentRegistered = path.join(root, "absent-registered", "openclaw-agent.sqlite");
  const pluginRoot = path.join(root, "plugin");
  const resource = path.join(root, "plugin-data", "preserved.txt");
  const missingResource = path.join(root, "plugin-data", "missing.txt");
  const currentPath = path.join(root, "releases", currentSha);
  const candidatePath = path.join(root, "releases", preparedSha);
  const env = {
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    XDG_CACHE_HOME: path.join(root, "cache"),
  };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  for (const file of [main, external, retained]) {
    database(file, 24).close();
  }
  const registry = database(shared, 1);
  registry.exec("CREATE TABLE agent_databases(agent_id TEXT, path TEXT);");
  const insert = registry.prepare("INSERT INTO agent_databases VALUES (?, ?)");
  const relativeMain = path.relative(stateDir, main);
  insert.run("main", main);
  insert.run("main", relativeMain);
  insert.run("retained", retained);
  insert.run("missing", absentRegistered);
  registry.close();
  write(resource, "plugin-owned synthetic content");
  write(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: "inspection-fixture",
      configSchema: {},
      doctorContract: { stateMigrations: true },
    }),
  );
  write(path.join(pluginRoot, "index.cjs"), 'throw new Error("must not boot plugin");\n');
  write(
    path.join(pluginRoot, "doctor-contract-api.cjs"),
    `module.exports = { stateMigrations: [{
      id: "private-state", label: "Private state",
      collectBackupResources: () => [
        { path: ${JSON.stringify(resource)}, kind: "file" },
        { path: ${JSON.stringify(missingResource)}, kind: "file" },
      ],
      detectLegacyState() { throw new Error("must not detect during inspection"); },
      migrateLegacyState() { throw new Error("must not migrate during inspection"); },
    }] };\n`,
  );
  write(
    configPath,
    JSON.stringify({
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          external: { agentDir: path.dirname(external) },
          absent: { agentDir: path.dirname(absentConfigured) },
        },
      },
      plugins: {
        allow: ["inspection-fixture"],
        load: { paths: [pluginRoot] },
        entries: { "inspection-fixture": { enabled: true } },
      },
    }),
  );
  for (const [generationPath, agent] of [
    [currentPath, 24],
    [candidatePath, 25],
  ] as const) {
    write(
      path.join(generationPath, "package.json"),
      JSON.stringify({ name: "openclaw", openclaw: { schemaVersions: { state: 1, agent } } }),
    );
    write(
      path.join(generationPath, "openclaw.mjs"),
      'throw new Error("must not boot candidate");\n',
    );
  }
  const record: ImmutableInstallRecord = {
    revision: 1,
    descriptor: {
      version: 2,
      activationEnabled: true,
      kind: "immutable",
      root,
      rootIdentity: "1:1",
      releasesIdentity: "1:2",
      current: {
        sha: currentSha,
        path: currentPath,
        identity: "1:3",
        pointerIdentity: "1:4",
        buildDigest: "1".repeat(64),
      },
      service: {
        unit: "synthetic-gateway.service",
        scope: "system",
        account: "synthetic",
        stateDir,
        configPath,
        profile: null,
      },
      runtime: { path: process.execPath, identity: "synthetic-runtime" },
      source: "https://github.com/openclaw/openclaw.git",
    },
    prepared: {
      sha: preparedSha,
      path: candidatePath,
      identity: "1:3",
      buildDigest: "2".repeat(64),
      preparedAtMs: 1,
      schemaVersions: { state: 1, agent: 25 },
    },
  };
  mocks.readRecord.mockResolvedValue(record);
  mocks.readService.mockResolvedValue({ command: { environment: env } });
  const scratch = resolvePrivateSqliteSnapshotStagingRoot(env);
  const capturePrefix = resolvePluginSourceCaptureFallbackPrefix(stateDir);
  return {
    root,
    stateDir,
    configPath,
    shared,
    main,
    relativeMain,
    external,
    retained,
    absentConfigured,
    absentRegistered,
    resource,
    missingResource,
    candidatePath,
    scratch,
    capturePrefix,
  };
}

function sourceFiles(root: string, excluded: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (file === excluded) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(file);
      } else {
        files.set(
          path.relative(root, file),
          entry.isSymbolicLink()
            ? Buffer.from(`symlink:${fs.readlinkSync(file)}`)
            : fs.readFileSync(file),
        );
      }
    }
  };
  visit(root);
  return files;
}

it("explains prepared schema crossings and complete live inventory without changing source state", async () => {
  const f = fixture();
  const before = sourceFiles(f.root, path.join(f.root, "cache"));
  const coverage = await inspectImmutableUpdateCoverage({ root: f.root });
  expect(coverage.warnings).toEqual([]);
  expect(coverage.target).toEqual({
    sha: preparedSha,
    preparation: "prepared",
    schemaVersions: { state: 1, agent: 25 },
  });
  expect(coverage.databases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: f.shared, userVersion: 1, coverage: "matching-version" }),
      expect.objectContaining({
        path: f.external,
        external: true,
        userVersion: 24,
        targetVersion: 25,
        owners: [{ role: "agent", agentId: "external" }],
        coverage: "migration-required",
      }),
      expect.objectContaining({
        path: f.retained,
        external: true,
        registeredPaths: [f.retained],
        owners: [{ role: "agent", agentId: "retained" }],
        coverage: "migration-required",
      }),
      expect.objectContaining({ path: f.absentConfigured, userVersion: null, coverage: "absent" }),
      expect.objectContaining({
        path: f.absentRegistered,
        registeredPaths: [f.absentRegistered],
        userVersion: null,
        coverage: "absent",
      }),
    ]),
  );
  expect(coverage.databases?.filter((row) => row.path === f.main)).toEqual([
    expect.objectContaining({
      spellings: [f.main],
      registeredPaths: expect.arrayContaining([f.main, f.relativeMain]),
    }),
  ]);
  expect(coverage.resources).toEqual(
    expect.arrayContaining([
      { path: f.resource, kind: "file", present: true, external: true, coverage: "unknown" },
      {
        path: f.missingResource,
        kind: "file",
        present: false,
        external: true,
        coverage: "unknown",
      },
    ]),
  );
  const text = formatImmutableUpdateCoverage(coverage).join("\n");
  expect(text).toContain("agent schema crossing 24 → 25");
  expect(text).toContain("offline migration is required before cutover");
  expect(text).toContain(f.relativeMain);
  expect(text).toContain("migration coverage unknown");
  expect(text).toContain("not physical-schema, migration, backup, or activation readiness proof");
  const after = sourceFiles(f.root, path.join(f.root, "cache"));
  expect([...after.keys()]).toEqual([...before.keys()]);
  expect(after).toEqual(before);
  expect(fs.readdirSync(f.scratch)).toEqual([]);
  expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(f.capturePrefix))).toEqual(
    [],
  );
});

it("keeps an unprepared SHA unknown without reading or running the retained candidate", async () => {
  const f = fixture();
  write(path.join(f.candidatePath, "package.json"), "invalid prepared metadata must not be read");
  const before = sourceFiles(f.root, path.join(f.root, "cache"));
  const targetSha = "c".repeat(40);
  const coverage = await inspectImmutableUpdateCoverage({ root: f.root, targetSha });
  expect(coverage.warnings).toEqual([]);
  expect(coverage.target).toEqual({ sha: targetSha, preparation: "unknown" });
  expect(coverage.databases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: f.external, userVersion: 24, coverage: "unknown" }),
      expect.objectContaining({ path: f.absentRegistered, userVersion: null, coverage: "absent" }),
    ]),
  );
  expect(formatImmutableUpdateCoverage(coverage).join("\n")).toContain(
    "Prepare the exact target with openclaw update --sha <commit> --no-restart",
  );
  const after = sourceFiles(f.root, path.join(f.root, "cache"));
  expect([...after.keys()]).toEqual([...before.keys()]);
  expect(after).toEqual(before);
  expect(fs.readdirSync(f.scratch)).toEqual([]);
  expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(f.capturePrefix))).toEqual(
    [],
  );
});

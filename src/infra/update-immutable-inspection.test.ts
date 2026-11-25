import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { resolvePluginSourceCaptureFallbackPrefix } from "../plugins/plugin-source-capture-path.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { listDirectoryTreeStrictSync } from "./directory-walk.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { immutableDescriptor } from "./package-update-activation-fixtures.test-support.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import {
  formatImmutableUpdateCoverage,
  inspectImmutableUpdateCoverage,
  type ImmutableUpdateCoverage,
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

function writeJson(file: string, value: unknown) {
  write(file, JSON.stringify(value));
}

const noBoot = 'throw new Error("must not boot during inspection");\n';

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
  const files = {
    configPath: path.join(stateDir, "openclaw.json"),
    shared: path.join(stateDir, "state", "openclaw.sqlite"),
    external: path.join(root, "external", "openclaw-agent.sqlite"),
    absentRegistered: path.join(root, "absent-registered", "openclaw-agent.sqlite"),
    resource: path.join(root, "plugin-data", "preserved.txt"),
    missingResource: path.join(root, "plugin-data", "missing.txt"),
    currentPath: path.join(root, "releases", currentSha),
    candidatePath: path.join(root, "releases", preparedSha),
  };
  const pluginRoot = path.join(root, "plugin");
  const env = {
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: files.configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    XDG_CACHE_HOME: path.join(root, "cache"),
  };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  database(files.external, 24).close();
  const registry = database(files.shared, 1);
  registry.exec("CREATE TABLE agent_databases(agent_id TEXT, path TEXT);");
  const insert = registry.prepare("INSERT INTO agent_databases VALUES (?, ?)");
  insert.run("missing", files.absentRegistered);
  registry.close();
  write(files.resource, "plugin-owned synthetic content");
  writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
    id: "inspection-fixture",
    configSchema: {},
    doctorContract: { stateMigrations: true },
  });
  write(path.join(pluginRoot, "index.cjs"), noBoot);
  write(
    path.join(pluginRoot, "doctor-contract-api.cjs"),
    `module.exports = { stateMigrations: [{
      id: "private-state", label: "Private state",
      collectBackupResources: () => [
        { path: ${JSON.stringify(files.resource)}, kind: "file" },
        { path: ${JSON.stringify(files.missingResource)}, kind: "file" },
      ],
      detectLegacyState() { throw new Error("must not detect during inspection"); },
      migrateLegacyState() { throw new Error("must not migrate during inspection"); },
    }] };\n`,
  );
  writeJson(files.configPath, {
    agents: {
      ownership: "explicit",
      entries: {
        external: { agentDir: path.dirname(files.external) },
      },
    },
    plugins: {
      allow: ["inspection-fixture"],
      load: { paths: [pluginRoot] },
      entries: { "inspection-fixture": { enabled: true } },
    },
  });
  for (const [generationPath, agent] of [
    [files.currentPath, 24],
    [files.candidatePath, 25],
  ] as const) {
    writeJson(path.join(generationPath, "package.json"), {
      name: "openclaw",
      openclaw: { schemaVersions: { state: 1, agent } },
    });
    write(path.join(generationPath, "openclaw.mjs"), noBoot);
  }
  const record: ImmutableInstallRecord = {
    revision: 1,
    descriptor: {
      ...immutableDescriptor(
        root,
        currentSha,
        "1".repeat(64),
        {
          unit: "synthetic-gateway.service",
          scope: "system",
          account: "synthetic",
          stateDir,
          configPath: files.configPath,
          profile: null,
        },
        "1:4",
      ),
      version: 2,
      activationEnabled: true,
    },
    prepared: {
      sha: preparedSha,
      path: files.candidatePath,
      identity: "1:3",
      buildDigest: "2".repeat(64),
      preparedAtMs: 1,
      schemaVersions: { state: 1, agent: 25 },
    },
  };
  mocks.readRecord.mockResolvedValue(record);
  mocks.readService.mockResolvedValue({ command: { environment: env } });
  return {
    ...files,
    root,
    stateDir,
    scratch: resolvePrivateSqliteSnapshotStagingRoot(env),
    capturePrefix: resolvePluginSourceCaptureFallbackPrefix(stateDir),
  };
}

function sourceFiles(root: string, excluded: string): Map<string, Buffer> {
  return new Map(
    listDirectoryTreeStrictSync(root, {
      skipDirectory: ({ relativePath }) => path.join(root, relativePath) === excluded,
    })
      .filter(({ dirent }) => !dirent.isDirectory())
      .map(({ relativePath, dirent }) => {
        const file = path.join(root, relativePath);
        return [
          relativePath,
          dirent.isSymbolicLink()
            ? Buffer.from(`symlink:${fs.readlinkSync(file)}`)
            : fs.readFileSync(file),
        ];
      }),
  );
}

function expectDatabases(
  coverage: ImmutableUpdateCoverage,
  rows: Record<string, Partial<NonNullable<ImmutableUpdateCoverage["databases"]>[number]>>,
) {
  for (const [file, row] of Object.entries(rows)) {
    expect(coverage.databases).toContainEqual(expect.objectContaining({ path: file, ...row }));
  }
}

function expectUnchanged(f: ReturnType<typeof fixture>, before: Map<string, Buffer>) {
  const after = sourceFiles(f.root, path.join(f.root, "cache"));
  expect(after).toEqual(before);
  expect(fs.readdirSync(f.scratch)).toEqual([]);
  expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(f.capturePrefix))).toEqual(
    [],
  );
}

it("explains prepared schema crossings and live inventory without changing source state", async () => {
  const f = fixture();
  const before = sourceFiles(f.root, path.join(f.root, "cache"));
  const coverage = await inspectImmutableUpdateCoverage({ root: f.root });
  expect(coverage.warnings).toEqual([]);
  expect(coverage.target).toEqual({
    sha: preparedSha,
    preparation: "prepared",
    schemaVersions: { state: 1, agent: 25 },
  });
  expectDatabases(coverage, {
    [f.shared]: { userVersion: 1, coverage: "matching-version" },
    [f.external]: {
      external: true,
      userVersion: 24,
      targetVersion: 25,
      owners: [{ role: "agent", agentId: "external" }],
      coverage: "migration-required",
    },
    [f.absentRegistered]: {
      registeredPaths: [f.absentRegistered],
      userVersion: null,
      coverage: "absent",
    },
  });
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
  expect(text).toContain(f.absentRegistered);
  expect(text).toContain("migration coverage unknown");
  expect(text).toContain("not physical-schema, migration, backup, or activation readiness proof");
  expectUnchanged(f, before);
});

it("reports recorded build isolation for current and prepared generations", async () => {
  const f = fixture();
  for (const generation of [f.currentPath, f.candidatePath]) {
    writeJson(path.join(generation, "dist", "build-info.json"), {
      immutableBuild: {
        builtBy: "operator",
        isolation: "none",
        account: "fixture",
        uid: 1002,
        gid: 1002,
      },
    });
  }
  const coverage = await inspectImmutableUpdateCoverage({ root: f.root });
  expect(coverage.warnings).toEqual([
    expect.stringContaining(
      "Current generation was built by the operator fixture (uid 1002, gid 1002)",
    ),
    expect.stringContaining(
      "Prepared generation was built by the operator fixture (uid 1002, gid 1002)",
    ),
  ]);
  expect(formatImmutableUpdateCoverage(coverage).join("\n")).toContain(
    "https://docs.openclaw.ai/cli/update",
  );
});

it("keeps an unprepared SHA unknown without reading or running the retained candidate", async () => {
  const f = fixture();
  write(path.join(f.candidatePath, "package.json"), "invalid prepared metadata must not be read");
  writeJson(path.join(f.candidatePath, "dist", "build-info.json"), {
    immutableBuild: { builtBy: "operator", isolation: "none" },
  });
  const before = sourceFiles(f.root, path.join(f.root, "cache"));
  const targetSha = "c".repeat(40);
  const coverage = await inspectImmutableUpdateCoverage({ root: f.root, targetSha });
  expect(coverage.warnings).toEqual([]);
  expect(coverage.target).toEqual({ sha: targetSha, preparation: "unknown" });
  expectDatabases(coverage, {
    [f.external]: { userVersion: 24, coverage: "unknown" },
  });
  expect(formatImmutableUpdateCoverage(coverage).join("\n")).toContain(
    "Prepare the exact target with openclaw update --sha <commit> --no-restart",
  );
  expectUnchanged(f, before);
});

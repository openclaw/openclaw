import "../../test-utils/prepare-compiled-subprocesses.js";
import "./database-suite-workers.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createGitBackup,
  restoreGitBackupRef,
  verifyGitBackupRef,
} from "../../snapshot/git-backup.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { requireGitCommand } from "../git-exec.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { agentPortProvider } from "./agent-port.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { logbookPortProvider } from "./logbook-port.js";
import { materializeDatabasePort } from "./port.worker.js";
import { statePortProvider } from "./state-port.js";
import { workboardPortProvider } from "./workboard-port.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);
const authoredConfig = vi.hoisted(() => ({
  config: undefined as OpenClawConfig | undefined,
  path: "",
}));

vi.mock("../../config/io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/io.js")>();
  return {
    ...actual,
    createConfigIO: (...args: Parameters<typeof actual.createConfigIO>) => {
      const io = actual.createConfigIO(...args);
      return {
        ...io,
        async readConfigFileSnapshot(...readArgs: Parameters<typeof io.readConfigFileSnapshot>) {
          if (!authoredConfig.config) {
            return io.readConfigFileSnapshot(...readArgs);
          }
          // Pin only authored config input. Discovery, PG capture, Git paths and
          // verification stay real, including on pre-fix builds with cold config IO.
          const { createTestConfigSnapshot } =
            await import("../../commands/test-runtime-config-helpers.js");
          return createTestConfigSnapshot(
            authoredConfig.config,
            authoredConfig.config,
            authoredConfig.path,
          );
        },
      };
    },
  };
});

describe.skipIf(!connection)("PostgreSQL Git backup discovery and verification", () => {
  const database = `git_backup_${randomUUID().replaceAll("-", "")}`;
  const fixtureConnection = new URL(connection ?? "postgresql://localhost/postgres");
  fixtureConnection.pathname = `/${database}`;
  const admin = new Client({ connectionString: connection });
  const client = new Client({ connectionString: fixtureConnection.href });
  let root: string;
  let stateDir: string;
  let shared: string;
  let agent: string;
  let workboard: string;
  const namespaces = new Map<string, string>();
  let databaseCreated = false;
  const lifetime = createFixtureLifetime();
  let initialRepositoryPath: string;
  let databases: Parameters<typeof createGitBackup>[0]["databases"];
  let result: Awaited<ReturnType<typeof createGitBackup>>;
  const gitEnv = {
    GIT_AUTHOR_NAME: "Backup fixture",
    GIT_AUTHOR_EMAIL: "backup@example.invalid",
    GIT_COMMITTER_NAME: "Backup fixture",
    GIT_COMMITTER_EMAIL: "backup@example.invalid",
  };
  const git = (repository: string, args: string[]) =>
    requireGitCommand(repository, args, { env: gitEnv });
  const backup = (
    repositoryPath: string,
    options: Partial<Parameters<typeof createGitBackup>[0]> = {},
  ) => createGitBackup({ repositoryPath, stateDir, databases, gitEnv, ...options });
  async function commitFixture(repository: string, message: string) {
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-m", message]);
  }
  const namespaceRows = async () =>
    (await client.query("SELECT nspname FROM pg_namespace ORDER BY nspname")).rows;
  function exportedRows(file: string, sql: string) {
    using exported = openNodeSqliteDatabase(file, { readOnly: true });
    return exported.prepare(sql).all();
  }
  const ordinaryRows = (file: string) =>
    exportedRows(
      file,
      "SELECT value_json FROM config_machine_state WHERE state_key='ordinary.fixture'",
    );
  const fixtureEnvironment = () => ({
    HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
  });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    databaseCreated = true;
    await client.connect();
    await client.query(
      "CREATE EXTENSION unaccent; CREATE EXTENSION pg_trgm; CREATE EXTENSION vector",
    );
    root = await fs.realpath(directories.make("git-postgres-"));
    stateDir = path.join(root, "state");
    shared = path.join(stateDir, "state/openclaw.sqlite");
    agent = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    workboard = path.join(stateDir, "plugins/workboard/workboard.sqlite");
    const config: OpenClawConfig = {
      database: { engine: "postgres", postgres: { connection: fixtureConnection.href } },
      agents: { ownership: "explicit", entries: { main: { agentDir: path.dirname(agent) } } },
      plugins: {
        entries: Object.fromEntries(
          ["matrix", "workboard", "logbook"].map((id) => [id, { enabled: false }]),
        ),
      },
    };
    const env = { ...process.env, ...fixtureEnvironment() };
    installFixtureEnvironment();
    const stateDescriptor = await statePortProvider.loadDescriptor();
    const agentDescriptor = await agentPortProvider.loadDescriptor();
    const stateSeed = `PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION};
      INSERT INTO schema_meta VALUES ('primary','global',${OPENCLAW_STATE_SCHEMA_VERSION},NULL,NULL,1,1);
      INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','${OPENCLAW_STATE_SCHEMA_VERSION}',1);
      INSERT INTO config_machine_state VALUES ('authProfiles.fixture','"synthetic-config-credential"',1);
      INSERT INTO config_machine_state VALUES ('ordinary.fixture','"retained"',1);
      INSERT INTO secret_store_entries VALUES ('team','','synthetic','synthetic-retained-secret','secret',1,1,NULL,NULL,NULL);
      INSERT INTO plugin_state_entries (plugin_id,namespace,entry_key,value_json,created_at)
        VALUES ('matrix','fixture','retained','{"marker":"matrix retained"}',1);`;
    const fixtures = [
      { file: shared, descriptor: stateDescriptor, seed: stateSeed },
      {
        file: agent,
        descriptor: agentDescriptor,
        seed: `PRAGMA user_version=${agentDescriptor.version};
          INSERT INTO schema_meta VALUES ('primary','agent',${agentDescriptor.version},'main',NULL,1,1);
          INSERT INTO session_key_contract (id,main_key,updated_at) VALUES (1,'main',0);
          INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at)
            VALUES ('agent:main:main','session','{}',1);`,
      },
      ...["one", "two"].map((id) => ({
        file: path.join(stateDir, `matrix/accounts/${id}/state/openclaw.sqlite`),
        descriptor: stateDescriptor,
        seed: stateSeed,
      })),
      {
        file: workboard,
        descriptor: await workboardPortProvider.loadDescriptor(),
        seed: "PRAGMA user_version=3; INSERT INTO workboard_schema_migrations VALUES ('schema-3',1); INSERT INTO workboard_boards (id,name,created_at,updated_at) VALUES ('board','retained board',1,1)",
      },
      {
        file: path.join(stateDir, "logbook/logbook.sqlite"),
        descriptor: await logbookPortProvider.loadDescriptor(),
        seed: "PRAGMA user_version=1; INSERT INTO standups VALUES ('2026-10-16','retained standup',1)",
      },
    ];
    for (const { file, descriptor, seed } of fixtures) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const storeId = randomUUID();
      const namespace = `git_backup_${storeId.replaceAll("-", "")}`;
      namespaces.set(file, namespace);
      {
        using source = openNodeSqliteDatabase(":memory:");
        source.exec(descriptor.sqlite);
        for (const fragment of descriptor.fragments ?? []) {
          source.exec(fragment.sqlite);
        }
        source.exec(seed);
        await materializeDatabasePort({
          source: { engine: "sqlite", db: source },
          destination: { engine: "postgres", db: client, namespace },
          descriptor,
          storeId,
          assertCurrent() {},
        });
      }
      using anchor = openNodeSqliteDatabase(file);
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
      );
      anchor
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(storeId, namespace);
    }
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
    authoredConfig.config = config;
    authoredConfig.path = env.OPENCLAW_CONFIG_PATH;
    setRuntimeConfigSnapshot(config);
    installDatabaseEngineSelection(await resolveDatabaseEngineSelection(config, env));
  }, 120_000);

  function installFixtureEnvironment() {
    for (const [key, value] of Object.entries(fixtureEnvironment())) {
      vi.stubEnv(key, value);
    }
  }

  // Vitest restores env stubs before every test, including the first.
  beforeEach(installFixtureEnvironment);

  // The initial six-store export is shared fixture setup for refresh/history assertions.
  beforeAll(
    () =>
      lifetime.run(async () => {
        initialRepositoryPath = path.join(root, "all-repository");
        databases = [
          { path: shared, identity: { role: "global" } as const },
          { path: agent, identity: { role: "agent", agentId: "main" } as const },
        ];
        result = await backup(initialRepositoryPath, { all: true, excludeSecrets: true });
      }),
    120_000,
  );

  // Join the original body before Vitest resets its env or starts another owner.
  afterEach(() => lifetime.cleanup());

  afterAll(async () => {
    await lifetime.cleanup();
    await closeOpenClawStateDatabaseAsync();
    clearRuntimeConfigSnapshot();
    authoredConfig.config = undefined;
    resetDatabaseEngineSelectionForTest();
    vi.unstubAllEnvs();
    try {
      await client.end();
      if (databaseCreated) {
        await admin.query(`DROP DATABASE "${database}"`);
      }
    } finally {
      await admin.end();
    }
  });

  it(
    "keeps distinct scopes, preserves degraded agents, and prunes removed Matrix stores without losing extras or history",
    () => lifetime.run(checkDiscoveryAndRefresh),
    120_000,
  );

  async function checkDiscoveryAndRefresh() {
    const repositoryPath = initialRepositoryPath;
    expect(result.manifests).toHaveLength(6);
    const ids = result.manifests.map(({ identity }) =>
      identity.role === "generic" ? identity.id : identity.role,
    );
    expect(new Set(ids).size).toBe(6);
    expect(ids).toEqual(expect.arrayContaining(["global", "workboard", "logbook"]));
    const files = (await git(repositoryPath, ["ls-tree", "-r", "--name-only", "HEAD"])).split("\n");
    expect(files.filter((file) => /(?:^|\/)manifest.json$/.test(file))).toHaveLength(12);
    const matrix = result.manifests.flatMap((manifest) =>
      manifest.identity.role === "generic" && manifest.identity.id.startsWith("state__matrix__")
        ? [{ manifest, id: manifest.identity.id }]
        : [],
    );
    expect(matrix).toHaveLength(2);
    for (const { manifest, id } of matrix) {
      expect(manifest.excludedTables).toContain("secret_store_entries");
      expect(manifest.excludedConfigStateKeyPrefixes).toContain("authProfiles.");
      const file = path.join(repositoryPath, "stores", id, "postgres", "database.sqlite");
      expect(exportedRows(file, "SELECT count(*) AS count FROM secret_store_entries")).toEqual([
        { count: 0 },
      ]);
      expect(
        exportedRows(
          file,
          "SELECT state_key FROM config_machine_state WHERE state_key LIKE 'authProfiles.%'",
        ),
      ).toEqual([]);
      expect(ordinaryRows(file)).toEqual([{ value_json: '"retained"' }]);
      expect(
        exportedRows(file, "SELECT value_json FROM plugin_state_entries WHERE plugin_id='matrix'"),
      ).toEqual([{ value_json: '{"marker":"matrix retained"}' }]);
      expect((await fs.readFile(file)).includes(Buffer.from("synthetic-retained-secret"))).toBe(
        false,
      );
    }

    const extras = matrix.map(({ id }) => `stores/${id}/postgres/operator-note.txt`);
    for (const file of extras) {
      await fs.writeFile(path.join(repositoryPath, file), "operator document\n");
    }
    await git(repositoryPath, ["add", "--", ...extras]);
    await fs.rm(path.join(stateDir, "matrix/accounts/one/state/openclaw.sqlite"));
    const previousAgentTree = await git(repositoryPath, ["rev-parse", "HEAD:agents/main"]);
    await client.query(`DROP SCHEMA "${namespaces.get(agent)}" CASCADE`);
    await client.query(
      `UPDATE "${namespaces.get(shared)}".config_machine_state SET value_json=$1 WHERE state_key='ordinary.fixture'`,
      ['"refreshed"'],
    );
    const refreshed = await backup(repositoryPath, { all: true, excludeSecrets: true });
    expect(refreshed.manifests).toHaveLength(4);
    expect(refreshed.warnings).toEqual([
      expect.stringMatching(/Agent main degraded.*missing namespace/u),
    ]);
    expect(await git(repositoryPath, ["rev-parse", "HEAD:agents/main"])).toBe(previousAgentTree);
    expect(ordinaryRows(path.join(repositoryPath, "global/postgres/database.sqlite"))).toEqual([
      { value_json: '"refreshed"' },
    ]);
    await expect(backup(repositoryPath, { databases: [databases[1]!] })).rejects.toThrow(
      "missing namespace",
    );
    const removed = matrix.filter(
      ({ id }) =>
        !refreshed.manifests.some(
          ({ identity }) => identity.role === "generic" && identity.id === id,
        ),
    );
    expect(removed).toHaveLength(1);
    const identity = removed[0]!.manifest.identity;
    await expect(verifyGitBackupRef({ repositoryPath, identity })).rejects.toThrow(
      "does not contain",
    );
    await expect(
      verifyGitBackupRef({ repositoryPath, identity, ref: result.commit }),
    ).resolves.toMatchObject({ manifest: removed[0]!.manifest });
    for (const file of extras) {
      await expect(fs.readFile(path.join(repositoryPath, file), "utf8")).resolves.toBe(
        "operator document\n",
      );
    }
    expect(
      (await git(repositoryPath, ["diff", "--cached", "--name-only"])).split("\n").toSorted(),
    ).toEqual(extras.toSorted());
  }

  it(
    "verifies without namespaces, restores legacy exports, and rejects swapped or corrupt capsules",
    () => lifetime.run(checkVerificationAndRestore),
    120_000,
  );

  async function checkVerificationAndRestore() {
    const repositoryPath = path.join(root, "verify-repository");
    const identity = { role: "global" } as const;
    const verify = () => verifyGitBackupRef({ repositoryPath, identity });
    const restore = (targetPath: string) =>
      restoreGitBackupRef({ repositoryPath, identity, targetPath });
    await backup(repositoryPath, {
      databases: [
        { path: shared, identity },
        {
          path: path.join(stateDir, "matrix/accounts/two/state/openclaw.sqlite"),
          identity: { role: "generic", id: "retained-state" },
        },
      ],
    });
    const before = await namespaceRows();
    const verified = await verify();
    expect(await namespaceRows()).toEqual(before);
    expect(verified.manifest.identity).toEqual(identity);

    const manifestPath = path.join(repositoryPath, "global/manifest.json");
    const originalManifest = await fs.readFile(manifestPath, "utf8");
    const legacyManifest: Record<string, unknown> = JSON.parse(originalManifest);
    await fs.writeFile(manifestPath, JSON.stringify({ ...legacyManifest, postgresSource: null }));
    await commitFixture(repositoryPath, "malformed binding fixture");
    await expect.soft(verify()).rejects.toThrow("unsupported fields");
    delete legacyManifest.postgresSource;
    await fs.writeFile(manifestPath, JSON.stringify(legacyManifest));
    await commitFixture(repositoryPath, "legacy fixture");
    expect((await verify()).manifest).not.toHaveProperty("postgresSource");
    const legacyTarget = path.join(root, "legacy-restored.sqlite");
    await restore(legacyTarget);
    expect(exportedRows(legacyTarget, "SELECT engine FROM openclaw_engine_anchor")).toEqual([
      { engine: "postgres" },
    ]);

    await fs.writeFile(manifestPath, originalManifest);
    await fs.cp(
      path.join(repositoryPath, "stores/retained-state/postgres"),
      path.join(repositoryPath, "global/postgres"),
      { recursive: true },
    );
    await commitFixture(repositoryPath, "swapped capsule fixture");
    const beforeInvalid = await namespaceRows();
    await expect.soft(verify()).rejects.toThrow("belongs to a different store");
    const targetPath = path.join(root, "mismatched-restored.sqlite");
    await expect.soft(restore(targetPath)).rejects.toThrow("belongs to a different store");
    await expect.soft(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect.soft(await namespaceRows()).toEqual(beforeInvalid);
    await fs.appendFile(path.join(repositoryPath, "global/postgres/database.sqlite"), "corrupt");
    await commitFixture(repositoryPath, "corrupt fixture");
    await expect(verify()).rejects.toThrow("artifact verification failed");
    expect(await namespaceRows()).toEqual(beforeInvalid);
  }
});

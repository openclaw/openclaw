import "../../test-utils/prepare-compiled-subprocesses.js";
import "./database-suite-workers.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createGitBackup, verifyGitBackupRef } from "../../snapshot/git-backup.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { requireGitCommand } from "../git-exec.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
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
  let workboard: string;
  let databaseCreated = false;
  const gitEnv = {
    GIT_AUTHOR_NAME: "Backup fixture",
    GIT_AUTHOR_EMAIL: "backup@example.invalid",
    GIT_COMMITTER_NAME: "Backup fixture",
    GIT_COMMITTER_EMAIL: "backup@example.invalid",
  };

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
    workboard = path.join(stateDir, "plugins/workboard/workboard.sqlite");
    const config: OpenClawConfig = {
      database: { engine: "postgres", postgres: { connection: fixtureConnection.href } },
      plugins: {
        entries: {
          matrix: { enabled: false },
          workboard: { enabled: false },
          logbook: { enabled: false },
        },
      },
    };
    const env = {
      ...process.env,
      HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    };
    for (const key of [
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    ] as const) {
      vi.stubEnv(key, env[key]);
    }
    const stateDescriptor = await statePortProvider.loadDescriptor();
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
        file: path.join(stateDir, "matrix/accounts/one/state/openclaw.sqlite"),
        descriptor: stateDescriptor,
        seed: stateSeed,
      },
      {
        file: path.join(stateDir, "matrix/accounts/two/state/openclaw.sqlite"),
        descriptor: stateDescriptor,
        seed: stateSeed,
      },
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

  afterAll(async () => {
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

  it("keeps distinct family scopes and prunes removed Matrix stores without losing extras or history", async () => {
    const repositoryPath = path.join(root, "all-repository");
    const result = await createGitBackup({
      repositoryPath,
      stateDir,
      databases: [{ path: shared, identity: { role: "global" } }],
      all: true,
      excludeSecrets: true,
      gitEnv,
    });
    expect(result.manifests).toHaveLength(5);
    const ids = result.manifests.map(({ identity }) =>
      identity.role === "generic" ? identity.id : identity.role,
    );
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual(expect.arrayContaining(["global", "workboard", "logbook"]));
    const files = (
      await requireGitCommand(repositoryPath, ["ls-tree", "-r", "--name-only", "HEAD"])
    ).split("\n");
    expect(files.filter((file) => /(?:^|\/)manifest.json$/.test(file))).toHaveLength(10);
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
      using exported = openNodeSqliteDatabase(file, { readOnly: true });
      expect(
        exported.prepare("SELECT count(*) AS count FROM secret_store_entries").get()?.count,
      ).toBe(0);
      expect(
        exported
          .prepare(
            "SELECT state_key FROM config_machine_state WHERE state_key LIKE 'authProfiles.%'",
          )
          .all(),
      ).toEqual([]);
      expect(
        exported
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key='ordinary.fixture'")
          .get()?.value_json,
      ).toBe('"retained"');
      expect(
        exported
          .prepare("SELECT value_json FROM plugin_state_entries WHERE plugin_id='matrix'")
          .get()?.value_json,
      ).toBe('{"marker":"matrix retained"}');
      expect((await fs.readFile(file)).includes(Buffer.from("synthetic-retained-secret"))).toBe(
        false,
      );
    }

    const extras = matrix.map(({ id }) => `stores/${id}/postgres/operator-note.txt`);
    for (const file of extras) {
      await fs.writeFile(path.join(repositoryPath, file), "operator document\n");
    }
    await requireGitCommand(repositoryPath, ["add", "--", ...extras]);
    await fs.rm(path.join(stateDir, "matrix/accounts/one/state/openclaw.sqlite"));
    const refreshed = await createGitBackup({
      repositoryPath,
      stateDir,
      databases: [{ path: shared, identity: { role: "global" } }],
      all: true,
      excludeSecrets: true,
      gitEnv,
    });
    expect(refreshed.manifests).toHaveLength(4);
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
      (await requireGitCommand(repositoryPath, ["diff", "--cached", "--name-only"]))
        .split("\n")
        .toSorted(),
    ).toEqual(extras.toSorted());
  }, 120_000);

  it("verifies matched artifacts without creating server namespaces, including corrupt artifacts", async () => {
    const repositoryPath = path.join(root, "verify-repository");
    const identity = { role: "generic", id: "workboard" } as const;
    await createGitBackup({
      repositoryPath,
      stateDir,
      databases: [{ path: workboard, identity }],
      gitEnv,
    });
    const before = (await client.query("SELECT nspname FROM pg_namespace ORDER BY nspname")).rows;
    const verified = await verifyGitBackupRef({ repositoryPath, identity });
    const after = (await client.query("SELECT nspname FROM pg_namespace ORDER BY nspname")).rows;
    expect(after).toEqual(before);
    expect(verified.manifest.identity).toEqual(identity);
    await fs.appendFile(
      path.join(repositoryPath, "stores/workboard/postgres/database.sqlite"),
      "corrupt",
    );
    await requireGitCommand(repositoryPath, ["add", "."]);
    await requireGitCommand(repositoryPath, ["commit", "-m", "corrupt fixture"], { env: gitEnv });
    await expect(verifyGitBackupRef({ repositoryPath, identity })).rejects.toThrow(
      "artifact verification failed",
    );
    expect((await client.query("SELECT nspname FROM pg_namespace ORDER BY nspname")).rows).toEqual(
      before,
    );
  }, 120_000);
});

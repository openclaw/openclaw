import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isSqliteSchemaVersionError } from "../../../infra/sqlite-user-version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { collectLegacyCronStoreHealthFindings, maybeRepairLegacyCronStore } from "./index.js";
import {
  applyLegacyCronStoreRepair,
  collectCronCodexRuntimePolicyTargetsReadOnly,
  loadLegacyCronRepairState,
  repairCronCodexModelRefsAfterConfigWrite,
  repairLegacyCronStoreWithoutPrompt,
} from "./legacy-repair.js";

type FutureSchemaFixture = Awaited<ReturnType<typeof createFixture>>;

let tempRoot: string | undefined;
let fixtureDatabase: DatabaseSync | undefined;
const futureSchemaSql = `
  CREATE TABLE preserved_sentinel (value TEXT NOT NULL) STRICT;
  INSERT INTO preserved_sentinel (value) VALUES ('keep-me');
  PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
`;

afterEach(async () => {
  fixtureDatabase?.close();
  fixtureDatabase = undefined;
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

async function writeFutureSchema(databasePath: string): Promise<void> {
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  using database = new DatabaseSync(databasePath);
  database.exec(futureSchemaSql);
}

async function createFixture(futureSchema = true) {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-schema-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  const quarantinePath = path.join(tempRoot, "cron", "jobs-quarantine.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(quarantinePath, JSON.stringify({ version: 1, jobs: [] }), "utf8");

  const databasePath = resolveOpenClawStateSqlitePath();
  if (futureSchema) {
    await writeFutureSchema(databasePath);
  }

  return {
    cfg: { cron: { store: storePath } } as OpenClawConfig,
    databasePath,
    storePath,
    quarantinePath,
  };
}

async function snapshotDirectory(directory: string) {
  const names = (await fs.readdir(directory)).toSorted();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await fs.readFile(path.join(directory, name))]),
    ),
  );
}

const snapshotFixture = ({ databasePath, storePath }: FutureSchemaFixture) =>
  Promise.all([
    snapshotDirectory(path.dirname(databasePath)),
    snapshotDirectory(path.dirname(storePath)),
  ]);

async function expectSchemaRefusalWithoutMutation(
  fixture: FutureSchemaFixture,
  operation: () => Promise<unknown>,
): Promise<void> {
  const before = await snapshotFixture(fixture);
  await expect(operation()).rejects.toSatisfy(isSqliteSchemaVersionError);
  await expect(snapshotFixture(fixture)).resolves.toEqual(before);
}

const entrypoints: Record<string, (cfg: OpenClawConfig) => Promise<unknown>> = {
  health: (cfg) => collectLegacyCronStoreHealthFindings({ cfg }),
  interactive: (cfg) =>
    maybeRepairLegacyCronStore({ cfg, options: {}, prompter: { confirm: vi.fn() } }),
  noninteractive: (cfg) => repairLegacyCronStoreWithoutPrompt({ cfg }),
  policyPlanning: (cfg) => collectCronCodexRuntimePolicyTargetsReadOnly({ cfg }),
  policyCommit: (cfg) =>
    repairCronCodexModelRefsAfterConfigWrite({ migrateCodexModelRefs: true, cfg }),
};

it.each(Object.entries(entrypoints))(
  "fails closed without mutation during %s",
  async (_name, operation) => {
    const fixture = await createFixture();
    await expectSchemaRefusalWithoutMutation(fixture, () => operation(fixture.cfg));
  },
);

it.each(["absent", "retired"])("fails closed with %s legacy source files", async (source) => {
  const fixture = await createFixture();
  if (source === "absent") {
    await fs.rm(fixture.quarantinePath);
  } else {
    await fs.writeFile(fixture.storePath, JSON.stringify({ version: 1, jobs: [] }), "utf8");
  }
  await expectSchemaRefusalWithoutMutation(fixture, () =>
    repairLegacyCronStoreWithoutPrompt({ cfg: fixture.cfg }),
  );
});

it("preserves active WAL artifacts while rejecting the future schema", async () => {
  const fixture = await createFixture(false);
  await fs.mkdir(path.dirname(fixture.databasePath), { recursive: true });
  fixtureDatabase = new DatabaseSync(fixture.databasePath);
  fixtureDatabase.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      ${futureSchemaSql}
    `);

  await expectSchemaRefusalWithoutMutation(fixture, () =>
    maybeRepairLegacyCronStore({ cfg: fixture.cfg, options: {}, prompter: { confirm: vi.fn() } }),
  );
});

it("fails closed if the schema advances between inspection and repair", async () => {
  const fixture = await createFixture(false);
  const state = await loadLegacyCronRepairState({ cfg: fixture.cfg });
  expect(state).not.toBeNull();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await writeFutureSchema(fixture.databasePath);

  await expectSchemaRefusalWithoutMutation(fixture, () =>
    applyLegacyCronStoreRepair({ cfg: fixture.cfg, state: state! }),
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { Client } from "pg";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../../infra/database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../../infra/database-engine/registry.js";
import { dropPostgresTestSchemas } from "../../infra/postgres-sync/schema-cleanup.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { git, initializeGitFixture } from "./git-fixture.test-support.js";
import { ManagedWorktreeService } from "./service.js";

const engine = process.argv[2];
const connection = process.env.OPENCLAW_TEST_WORKTREE_REMOVAL_DSN;
assert(engine === "postgres" || engine === "sqlite");
assert(connection);
assert.equal(threadId, 0);
const schemaPrefix = `worktree_remove_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
installDatabaseProcessRole("gateway");
installDatabaseEngineSelection({
  effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
  ...(engine === "postgres" ? { postgres: { connection, schemaPrefix } } : {}),
});

try {
  const { db } = withEngineStoreAdmission(() => openOpenClawStateDatabase());
  const repoRoot = await initializeGitFixture(process.cwd(), "repo", "README.md", "base\n");
  const service = new ManagedWorktreeService({
    getConfig: () => ({ worktreeAcceleration: false }),
  });
  const checkout = await service.create({ repoRoot, name: "removal-proof", baseRef: "HEAD" });
  await fs.writeFile(path.join(checkout.path, "README.md"), "unsaved change\n");

  const removed = await service.remove({ id: checkout.id, reason: "manual-delete" });
  assert(removed.removed && removed.snapshotRef);
  await assert.rejects(fs.stat(checkout.path), { code: "ENOENT" });
  assert.equal(await git(repoRoot, "show", `${removed.snapshotRef}:README.md`), "unsaved change");
  const record = (await service.listRegistryRecords()).find(({ id }) => id === checkout.id);
  assert.equal(record?.snapshotRef, removed.snapshotRef);
  assert.equal(typeof record?.removedAt, "number");
  if (engine === "postgres") {
    assert.throws(
      () => db.prepare("SELECT 1").get(),
      /PostgreSQL connections must run in a worker/,
    );
  }
  console.log(`Managed worktree removal passed: ${engine}`);
} finally {
  await closeOpenClawStateDatabaseAsync();
  if (engine === "postgres") {
    const client = new Client({ connectionString: connection });
    await client.connect();
    try {
      await dropPostgresTestSchemas(client, schemaPrefix);
    } finally {
      await client.end();
    }
  }
}

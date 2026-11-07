import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { insertRepositoryGitHubPublicationAsync } from "../../gateway/github-publication-request-async.js";
import { bindGitHubPublicationSource } from "../../gateway/github-publication-source.js";
import { listRepositoryGitHubPublicationsInDatabase } from "../../gateway/github-repository-publication-read.worker.js";
import { repositoryGitHubPublicationDigest } from "../../gateway/github-repository-publication.kernel.js";
import { waitForPublicationGate } from "../../state/github-publication-fixtures.test-support.js";
import { encodeGitHubPublicationRequester } from "../../state/github-publication-requester.js";
import { repositoryRow } from "../../state/github-publication.worker.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { ensureRepositoryGitHubPublicationSchema } from "../../state/openclaw-state-db-schema-additive.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceInDatabase } from "../../state/session-repository-workspaces.kernel.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import {
  denyWhileSourceReserved,
  preparePublicationAuthority,
} from "./github-publication-authority.conformance.test-support.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "./mixed-agent.conformance.test-support.js";
import { getPostgresPhysicalFactsForPath } from "./physical-facts.js";

describe.skipIf(!mixedAgentConnection).each(mixedAgentPairs)(
  "publication with $stateEngine state and $agentEngine sessions",
  ({ stateEngine, agentEngine }) => {
    useMixedAgentPair(stateEngine, agentEngine);

    it("persists only publications whose configured source session remains current", async ({
      signal,
    }) => {
      await captureRuntimeConfigAsyncReader()();
      withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) => ensureRepositoryGitHubPublicationSchema(db)),
      );
      const row = repositoryRow(randomUUID());
      row.session_id = row.request_id;
      row.session_key = `agent:main:${row.request_id}`;
      const workspace = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) =>
          createSessionRepositoryWorkspaceInDatabase(
            db,
            {
              agentId: row.agent_id,
              sessionKey: row.session_key,
              url: "https://github.com/example/repository",
              branch: row.branch,
            },
            1000,
          ),
        ),
      );
      row.workspace_id = workspace.workspaceId;
      const target = { agentId: row.agent_id, sessionKey: row.session_key };
      const authority = await preparePublicationAuthority(target, signal);
      const entry = await upsertSessionEntryCore(target, {
        createdActor: { type: "human", source: "profile", id: authority.profileId },
        sessionId: row.session_id,
        updatedAt: 1000,
        repositoryWorkspaceId: row.workspace_id,
      });
      row.session_lifecycle_revision = entry!.lifecycleRevision ?? null;
      let requester = await authority.capture();
      await authority.rejectForeign();
      row.requester_authority_json = encodeGitHubPublicationRequester(requester.snapshot);
      row.request_digest = repositoryGitHubPublicationDigest(row);
      const prepare = () =>
        requester.prepareSource({
          ...target,
          sessionId: row.session_id,
          lifecycleRevision: row.session_lifecycle_revision,
          repositoryWorkspaceId: row.workspace_id,
          repositoryBranch: row.branch,
        });
      const source = await prepare();
      try {
        await expect(
          stateEngine === "postgres"
            ? insertWithReservedSource(row, source, signal)
            : insertRepositoryGitHubPublicationAsync(row, source),
        ).resolves.toMatchObject({
          request_id: row.request_id,
          status: "requested",
        });
      } finally {
        await source.release();
      }
      const queuedSource = await prepare();
      const queued = { ...row, request_id: randomUUID(), idempotency_key: randomUUID() };
      queued.request_digest = repositoryGitHubPublicationDigest(queued);
      try {
        await denyWhileSourceReserved(queued, queuedSource, authority);
        expect(
          withEngineStoreAdmission(() =>
            listRepositoryGitHubPublicationsInDatabase(openOpenClawStateDatabase().db, {
              idempotencyKey: queued.idempotency_key,
            }),
          ),
        ).toEqual([]);
      } finally {
        await queuedSource.release();
      }
      authority.restore();
      requester = await authority.capture();
      const stale = await prepare();
      try {
        await upsertSessionEntryCore(target, { archivedAt: 2000 });
        await expect(insertRepositoryGitHubPublicationAsync(row, stale)).rejects.toThrow(
          /changed|expired/,
        );
        expect(
          withEngineStoreAdmission(() =>
            listRepositoryGitHubPublicationsInDatabase(openOpenClawStateDatabase().db, {
              idempotencyKey: row.idempotency_key,
            }),
          ),
        ).toEqual([
          expect.objectContaining({
            request_id: row.request_id,
            status: "requested",
            requester_authority_json: row.requester_authority_json,
          }),
        ]);
      } finally {
        await stale.release();
      }
    });
  },
);

/** Block a real deferred COMMIT, then try the same lock used by a competing source writer. */
async function insertWithReservedSource(
  row: Parameters<typeof insertRepositoryGitHubPublicationAsync>[0],
  source: Parameters<typeof insertRepositoryGitHubPublicationAsync>[1],
  signal: AbortSignal,
) {
  const binding = bindGitHubPublicationSource(source);
  const facts = getPostgresPhysicalFactsForPath(binding.context.admission.databasePath)!;
  const schema = `"${facts.namespace.replaceAll('"', '""')}"`;
  const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: row.agent_id });
  const sourceFacts = getPostgresPhysicalFactsForPath(sourcePath);
  const admin = new Client({ connectionString: mixedAgentConnection });
  await admin.connect();
  const gate = 1983170241;
  let inserting: ReturnType<typeof insertRepositoryGitHubPublicationAsync> | undefined;
  let settled = false;
  try {
    await admin.query(`CREATE FUNCTION ${schema}.publication_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER publication_gate AFTER INSERT ON ${schema}.github_repository_publication_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${schema}.publication_gate()`);
    await admin.query("SELECT pg_advisory_lock($1)", [gate]);
    inserting = insertRepositoryGitHubPublicationAsync(row, source);
    void inserting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const observeCommit = async () => {
      for (;;) {
        if (settled) {
          return;
        }
        signal.throwIfAborted();
        const result = await admin.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND NOT granted) AS waiting",
          [gate],
        );
        if (result.rows[0]?.waiting) {
          return;
        }
      }
    };
    await waitForPublicationGate(signal, inserting, observeCommit());
    if (sourceFacts) {
      const key = createHash("sha256").update(sourceFacts.storeId).digest().readBigInt64BE();
      expect(
        (
          await admin.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired", [
            key.toString(),
          ])
        ).rows,
      ).toEqual([{ acquired: false }]);
    } else {
      const competing = openNodeSqliteDatabase(sourcePath);
      try {
        competing.exec("PRAGMA busy_timeout = 0");
        expect(() => competing.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
      } finally {
        if (competing.isTransaction) {
          competing.exec("ROLLBACK");
        }
        competing.close();
      }
    }
    await admin.query("SELECT pg_advisory_unlock($1)", [gate]);
    return await inserting;
  } finally {
    await admin.query("SELECT pg_advisory_unlock_all()");
    await inserting?.catch(() => {});
    await admin.query(`DROP TRIGGER IF EXISTS publication_gate ON ${schema}.github_repository_publication_requests;
      DROP FUNCTION IF EXISTS ${schema}.publication_gate()`);
    await admin.end();
  }
}

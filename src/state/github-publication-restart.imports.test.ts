import { expect, it, vi } from "vitest";
import { personalGitHubRequestDigest } from "../gateway/github-personal-publication-store.js";
import type { PersonalGitHubPublicationRow } from "../gateway/github-personal-publication-store.worker.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { publicationRowDefaults } from "./github-publication-fixtures.test-support.js";
import { ensurePersonalGitHubPublicationSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { openExistingSqliteWorkerBackend } from "./openclaw-state.worker.js";

const loaded = vi.hoisted(() => ({ publication: false, source: false }));
// Pass through real operations while observing the cold backend's module boundary.
vi.mock("./github-publication.worker.js", async (importOriginal) => {
  loaded.publication = true;
  return importOriginal();
});
vi.mock("./github-publication-source.worker.js", async (importOriginal) => {
  loaded.source = true;
  return importOriginal();
});

it("restarts personal publications with committed receipts without loading source commands", async () => {
  await withOpenClawTestState({ label: "publication-restart-imports" }, async () => {
    const database = openOpenClawStateDatabase();
    const context = captureOpenClawStateWorkerContext();
    const backend = runWithSqliteWorkerStateContext(context, () =>
      openExistingSqliteWorkerBackend(undefined, {
        databasePath: database.path,
        existingIdentity: context.admission.identity.key,
      }),
    );
    const requested = "00000000-0000-4000-8000-000000000001";
    const publishing = "00000000-0000-4000-8000-000000000002";
    const sameInstance = "00000000-0000-4000-8000-000000000003";
    const command = {
      type: "githubPublications.personalRestart",
      input: { operation: "restart", instanceId: "current", operationId: "restart-proof" },
    } as const;
    const restart = () => {
      const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
        context.admission.assertCurrent();
        grant();
      });
      const post = admission.port.postMessage.bind(admission.port);
      const dispatch = vi
        .spyOn(admission.port, "postMessage")
        .mockImplementation((message, transfer) => {
          post(message, transfer);
          admission.service();
        });
      try {
        runWithSqliteWorkerStateContext(context, () =>
          withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
            backend.execute(command),
          ),
        );
        admission.service();
        expect(admission.committed).toBeDefined();
        return admission.committed?.facts;
      } finally {
        dispatch.mockRestore();
        admission.finish();
      }
    };
    try {
      expect(loaded).toEqual({ publication: false, source: false });
      await backend[SQLITE_WORKER_PREPARE_COMMAND]?.(command.type);
      expect(tableExists(database.db, "github_personal_publication_requests")).toBe(false);
      expect(restart()).toMatchObject({
        operationId: "restart-proof",
        operation: "restart",
        kind: "personal",
        rows: [],
      });
      expect(tableExists(database.db, "github_personal_publication_requests")).toBe(false);
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          ensurePersonalGitHubPublicationSchema(db);
          const rows = [
            { id: requested, status: "requested", instance: null },
            { id: publishing, status: "publishing", instance: "previous" },
            { id: sameInstance, status: "publishing", instance: "current" },
          ].map(({ id, status, instance }) => {
            const row: PersonalGitHubPublicationRow = Object.assign(publicationRowDefaults(id), {
              owner_profile_id: "fixture-owner",
              connection_generation: "00000000-0000-4000-8000-000000000004",
              worktree_id: "fixture-worktree",
              repository_fingerprint: "fixture-fingerprint",
              identity_source: "personal",
              identity_profile_id: "00000000-0000-4000-8000-000000000005",
              status,
              gateway_instance_id: instance,
              execution_id: status === "publishing" ? "00000000-0000-4000-8000-000000000006" : null,
            });
            row.request_digest = personalGitHubRequestDigest(row);
            return row;
          });
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .insertInto("github_personal_publication_requests")
              .values(rows),
          );
        },
        { database },
      );
      expect(restart()).toMatchObject({
        operationId: "restart-proof",
        operation: "restart",
        kind: "personal",
        rows: expect.arrayContaining([
          expect.objectContaining({ request_id: requested, status: "needs_confirmation" }),
          expect.objectContaining({ request_id: publishing, status: "needs_confirmation" }),
        ]),
      });
      expect(
        database.db
          .prepare(
            "SELECT request_id, status FROM github_personal_publication_requests ORDER BY request_id",
          )
          .all(),
      ).toEqual([
        { request_id: requested, status: "needs_confirmation" },
        { request_id: publishing, status: "needs_confirmation" },
        { request_id: sameInstance, status: "publishing" },
      ]);
      expect(loaded).toEqual({ publication: false, source: false });
    } finally {
      await backend.close();
    }
  });
});

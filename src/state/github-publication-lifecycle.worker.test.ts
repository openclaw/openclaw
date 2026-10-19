import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { personalGitHubRequestDigest } from "../gateway/github-personal-publication-store.js";
import {
  insertPersonalGitHubPublicationInDatabase,
  type PersonalGitHubPublicationRow,
} from "../gateway/github-personal-publication-store.worker.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "./github-personal-publication-lifecycle.js";
import {
  holdStateRead,
  observePublicationAuthority,
  publicationRowDefaults,
  waitForPublicationGate,
} from "./github-publication-fixtures.test-support.js";
import { prepareGitHubPublicationSessionLifecycle } from "./github-publication-session-lifecycles.js";
import {
  insertGitHubPublicationSessionLifecycle,
  readGitHubPublicationSessionLifecycle,
} from "./github-publication-session-lifecycles.worker.js";
import {
  holdNextReceipt,
  holdNextReply,
  releaseHeldGitHubPublicationMessages,
} from "./github-publication.worker.test-support.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const receiptFault = useSqliteWorkerFault([
  {
    name: "fail_receipt_batch",
    match: /^delete from github_personal_publication_requests\b/u,
    sql: `CREATE TEMP TRIGGER fail_receipt_batch BEFORE DELETE ON main.github_personal_publication_requests
      WHEN OLD.request_id = '00000000-0000-4000-8000-000000000064'
      BEGIN SELECT RAISE(ABORT, 'synthetic receipt deletion failure'); END;`,
  },
]);

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterAll(cleanup));

describe("retained publication lifecycle authority", () => {
  let lifecycleRoot: string;
  let lifecycleContext: OpenClawStateWorkerContext;
  let profileId: string;
  const connectionGeneration = randomUUID();
  const deleteRequestId = randomUUID();
  const coldRequestId = randomUUID();
  const lifecycleCases = (["shared", "personal"] as const).flatMap((publicationKind) =>
    (["original-revision", null, "missing"] as const).map((revision) => ({
      publicationKind,
      revision,
      requestId: randomUUID(),
    })),
  );
  const requester = {
    version: 1 as const,
    actor: { kind: "system" as const },
    scopes: ["operator.admin"],
    grant: null,
  };
  const requesterJson =
    '{"version":1,"actor":{"kind":"system"},"scopes":["operator.admin"],"grant":null}';
  const unavailable = "lifecycle authority is unavailable";

  function personalRow(requestId: string): PersonalGitHubPublicationRow {
    const row: PersonalGitHubPublicationRow = {
      ...publicationRowDefaults(requestId),
      owner_profile_id: profileId,
      connection_generation: connectionGeneration,
      worktree_id: "fixture-worktree",
      repository_fingerprint: "fixture-fingerprint",
      identity_source: "personal",
      identity_profile_id: profileId,
    };
    row.request_digest = personalGitHubRequestDigest(row);
    return row;
  }
  function insertPersonal(requestId: string, revision: string) {
    runOpenClawStateWriteTransaction((database) =>
      insertPersonalGitHubPublicationInDatabase(
        database,
        personalRow(requestId),
        revision,
        lifecycleContext.admission.assertCurrent,
      ),
    );
  }
  function prepareDeletion(...requestIds: string[]) {
    return preparePersonalGitHubSessionReceiptDeletion({
      agentId: "main",
      generations: requestIds.map((requestId) => ({
        sessionKey: `agent:main:${requestId}`,
        sessionId: requestId,
        lifecycleRevision: "original-revision",
      })),
    });
  }
  function durable(requestId: string) {
    return readGitHubPublicationSessionLifecycle(
      { publicationKind: "personal", requestId },
      openOpenClawStateDatabase().db,
    );
  }
  function expectSelectedRows(kind: "requests" | "lifecycles", requestIds: string[]) {
    const table =
      kind === "requests"
        ? "github_personal_publication_requests"
        : "github_publication_session_lifecycles";
    const personal = kind === "lifecycles" ? "publication_kind = 'personal' AND" : "";
    expect(
      openOpenClawStateDatabase()
        .db.prepare(
          `SELECT request_id FROM ${table} WHERE ${personal}
       request_id LIKE '00000000-0000-4000-8000-%' ORDER BY request_id`,
        )
        .all(),
    ).toEqual(requestIds.map((request_id) => ({ request_id })));
  }

  beforeAll(async () => {
    lifecycleRoot = tempDirs.make("openclaw-publication-lifecycle-");
    vi.stubEnv("OPENCLAW_STATE_DIR", lifecycleRoot);
    openOpenClawStateDatabase();
    lifecycleContext = captureOpenClawStateWorkerContext();
    profileId = ensureProfileForEmail("lifecycle-worker@example.test").id;
    runOpenClawStateWriteTransaction(({ db }) => {
      for (const { revision, ...input } of lifecycleCases) {
        if (revision !== "missing") {
          insertGitHubPublicationSessionLifecycle(db, {
            ...input,
            lifecycleRevision: revision,
            requester,
          });
        }
      }
    });
    for (const requestId of [deleteRequestId, coldRequestId]) {
      insertPersonal(requestId, "original-revision");
    }
    // A real close drops resident facts so the next preparations exercise cold worker reads.
    await closeOpenClawStateDatabaseByPathAsync(lifecycleContext.admission.databasePath);
    openOpenClawStateDatabase();
    lifecycleContext = captureOpenClawStateWorkerContext();
  });
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", lifecycleRoot);
    setRuntimeConfigSnapshot({});
  });
  afterEach(() => {
    releaseHeldGitHubPublicationMessages();
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
  });
  afterAll(async () => {
    await closeOpenClawStateDatabaseByPathAsync(lifecycleContext.admission.databasePath);
    vi.unstubAllEnvs();
  });

  it("loads shared and personal revisions, retained NULL and missing rows through the worker", async () => {
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      for (const { revision, ...input } of lifecycleCases) {
        const binding = await prepareGitHubPublicationSessionLifecycle(input);
        const expected =
          revision === "missing"
            ? undefined
            : { lifecycle_revision: revision, requester_authority_json: requesterJson };
        expect(binding.readCurrent()).toEqual(expected);
        const requests = vi.spyOn(Worker.prototype, "postMessage");
        try {
          expect((await prepareGitHubPublicationSessionLifecycle(input)).readCurrent()).toEqual(
            expected,
          );
          expect(binding.readCurrent()).toEqual(expected);
          expect(requests).not.toHaveBeenCalled();
        } finally {
          requests.mockRestore();
        }
      }
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it("denies before deletion commits and never revives the retained binding after reinsertion", async ({
    signal,
  }) => {
    const input = { publicationKind: "personal" as const, requestId: deleteRequestId };
    const binding = await prepareGitHubPublicationSessionLifecycle(input);
    const remove = await prepareDeletion(input.requestId);
    const receipt = holdNextReceipt();
    let deniedBeforeDispatch = false;
    const reply = holdNextReply("githubPublication.deleteSessionReceipts", () => {
      expect(binding.readCurrent).toThrow(unavailable);
      deniedBeforeDispatch = true;
    });
    const deleting = remove();
    try {
      await waitForPublicationGate(signal, deleting, reply.ready, receipt.ready);
      expect(deniedBeforeDispatch).toBe(true);
      expect(durable(input.requestId)).toBeUndefined();
      expect(binding.readCurrent).toThrow(unavailable);
      await expect(prepareGitHubPublicationSessionLifecycle(input)).rejects.toThrow(unavailable);
    } finally {
      receipt.release();
      reply.release();
      await deleting;
    }
    expect(binding.readCurrent).toThrow(unavailable);
    expect((await prepareGitHubPublicationSessionLifecycle(input)).readCurrent()).toBeUndefined();
    insertPersonal(input.requestId, "replacement-revision");
    expect(binding.readCurrent).toThrow(unavailable);
    expect((await prepareGitHubPublicationSessionLifecycle(input)).readCurrent()).toEqual({
      lifecycle_revision: "replacement-revision",
      requester_authority_json: null,
    });
  });

  it("rejects a cold worker result overtaken by a canonical deletion", async ({ signal }) => {
    const input = { publicationKind: "personal" as const, requestId: coldRequestId };
    const remove = await prepareDeletion(input.requestId);
    const read = holdStateRead();
    const preparing = prepareGitHubPublicationSessionLifecycle(input);
    const rejected = expect(preparing).rejects.toThrow(unavailable);
    try {
      await waitForPublicationGate(signal, preparing, read.ready);
      await remove();
      expect(durable(input.requestId)).toBeUndefined();
    } finally {
      read.release();
    }
    await rejected;
    expect((await prepareGitHubPublicationSessionLifecycle(input)).readCurrent()).toBeUndefined();
  });

  it("rolls back receipt batches and publishes only the exact committed tombstones", async () => {
    const databasePath = lifecycleContext.admission.databasePath;
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    openOpenClawStateDatabase();
    lifecycleContext = captureOpenClawStateWorkerContext();
    const selected = Array.from({ length: 65 }, (_, index) =>
      personalRow(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    );
    const selectedIds = selected.map((row) => row.request_id);
    const retained = personalRow(randomUUID());
    runOpenClawStateWriteTransaction((database) => {
      for (const row of [...selected, retained]) {
        insertPersonalGitHubPublicationInDatabase(
          database,
          row,
          "original-revision",
          lifecycleContext.admission.assertCurrent,
        );
      }
      // Shared and personal lifecycle keys can use the same request ID.
      insertGitHubPublicationSessionLifecycle(database.db, {
        publicationKind: "shared",
        requestId: selected[0]!.request_id,
        lifecycleRevision: "shared-revision",
        requester,
      });
    });
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    lifecycleContext = captureOpenClawStateWorkerContext();
    const { facts: installed, stop } = observePublicationAuthority();
    try {
      const remove = await prepareDeletion(...selectedIds);
      receiptFault.enable();
      await expect(remove()).rejects.toThrow("synthetic receipt deletion failure");
      receiptFault.disable();
      expect(installed.size).toBe(0);
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      expectSelectedRows("requests", selectedIds);
      expectSelectedRows("lifecycles", selectedIds);
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      lifecycleContext = captureOpenClawStateWorkerContext();
      const retry = await prepareDeletion(...selectedIds);
      await retry();
      const expected = new Map<string, unknown>();
      for (const row of selected) {
        expected.set(JSON.stringify(["personal", row.request_id]), { kind: "absent" });
        expected.set(JSON.stringify(["personal-lifecycle", row.request_id]), { kind: "absent" });
      }
      expect(installed).toEqual(expected);
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      const reopened = openOpenClawStateDatabase().db;
      expectSelectedRows("requests", []);
      expectSelectedRows("lifecycles", []);
      expect(
        reopened
          .prepare(
            "SELECT request_id FROM github_personal_publication_requests WHERE request_id = ?",
          )
          .get(retained.request_id),
      ).toEqual({ request_id: retained.request_id });
      expect(durable(retained.request_id)?.lifecycle_revision).toBe("original-revision");
      expect(
        readGitHubPublicationSessionLifecycle(
          { publicationKind: "shared", requestId: selected[0]!.request_id },
          reopened,
        )?.lifecycle_revision,
      ).toBe("shared-revision");
    } finally {
      receiptFault.disable();
      stop();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      lifecycleContext = captureOpenClawStateWorkerContext();
    }
  });
});

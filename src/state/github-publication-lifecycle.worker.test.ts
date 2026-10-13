import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
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
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "./github-personal-publication-lifecycle.js";
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
import * as stateReads from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { ensureProfileForEmail } from "./user-profiles.js";

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
      request_id: requestId,
      owner_profile_id: profileId,
      connection_generation: connectionGeneration,
      idempotency_key: requestId,
      request_digest: "",
      session_id: requestId,
      session_key: `agent:main:${requestId}`,
      agent_id: "main",
      worktree_id: "fixture-worktree",
      repository_fingerprint: "fixture-fingerprint",
      identity_source: "personal",
      identity_profile_id: profileId,
      identity_account_id: 42,
      identity_login: "fixture-bot",
      title: null,
      body: null,
      status: "requested",
      gateway_instance_id: null,
      execution_id: null,
      push_repository: "example/repository",
      repository: "example/repository",
      branch: "openclaw/worker-proof",
      base_branch: "main",
      source_head_commit: "b".repeat(40),
      source_index_tree: "c".repeat(40),
      workspace_tree: "c".repeat(40),
      head_commit: null,
      pull_request_url: null,
      error_code: null,
      next_action: null,
      last_effect: null,
      effect_state: null,
      created_at_ms: 1000,
      updated_at_ms: 1000,
      reported_at_ms: null,
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
  function prepareDeletion(requestId: string) {
    const row = personalRow(requestId);
    return preparePersonalGitHubSessionReceiptDeletion({
      agentId: row.agent_id,
      generations: [
        {
          sessionKey: row.session_key,
          sessionId: row.session_id,
          lifecycleRevision: "original-revision",
        },
      ],
    });
  }
  function durable(requestId: string) {
    return readGitHubPublicationSessionLifecycle(
      { publicationKind: "personal", requestId },
      openOpenClawStateDatabase().db,
    );
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
      await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([reply.ready, receipt.ready]),
          deleting,
          "deletion was not held before its receipt and reply",
        ),
        signal,
      );
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
    const readReady = createDeferredCore();
    const release = createDeferredCore();
    const read = stateReads.executeExistingOpenClawStateRead;
    const delayedRead: typeof read = async (options, command, readOptions) => {
      const result = await read(options, command, readOptions);
      readReady.resolve();
      await release.promise;
      return result;
    };
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementationOnce(delayedRead);
    const preparing = prepareGitHubPublicationSessionLifecycle(input);
    const rejected = expect(preparing).rejects.toThrow(unavailable);
    try {
      await withinTest(
        awaitGateBeforeSettlement(readReady.promise, preparing, "cold read was not held"),
        signal,
      );
      await remove();
      expect(durable(input.requestId)).toBeUndefined();
    } finally {
      release.resolve();
    }
    await rejected;
    expect((await prepareGitHubPublicationSessionLifecycle(input)).readCurrent()).toBeUndefined();
  });
});

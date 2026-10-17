import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { digestGitHubPublicationRequest } from "../gateway/github-publication-receipt.js";
import {
  insertGitHubPublicationRequestAsync,
  insertRepositoryGitHubPublicationAsync,
} from "../gateway/github-publication-request-async.js";
import {
  bindGitHubPublicationSource,
  prepareGitHubPublicationSource,
} from "../gateway/github-publication-source.js";
import {
  claimRepositoryGitHubPublicationAsync,
  readGitHubPublicationRequestAsync,
  runGitHubPublicationMaintenanceAsync,
} from "../gateway/github-publication-store-async.js";
import { listRepositoryGitHubPublicationsInDatabase } from "../gateway/github-repository-publication-read.worker.js";
import {
  claimRepositoryGitHubPublicationInDatabase,
  insertRepositoryGitHubPublicationInDatabase,
} from "../gateway/github-repository-publication-store.worker.js";
import { repositoryGitHubPublicationDigest } from "../gateway/github-repository-publication.kernel.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "./github-personal-publication-lifecycle.js";
import type { RepositoryGitHubPublicationRow as RepositoryPublicationRow } from "./github-publication-read.types.js";
import {
  captureGitHubPublicationLifecycle,
  githubPublicationReceipts,
} from "./github-publication-receipts.js";
import { prepareGitHubPublicationSessionLifecycle } from "./github-publication-session-lifecycles.js";
import { insertGitHubPublicationSessionLifecycle } from "./github-publication-session-lifecycles.worker.js";
import { createGitHubPublicationWorkerScope } from "./github-publication-worker.js";
import type {
  PublicationMutationReceipt,
  RepositoryPublicationMutation,
} from "./github-publication-worker.types.js";
import {
  holdNextReceipt,
  holdNextReply,
  releaseHeldGitHubPublicationMessages,
} from "./github-publication.worker.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  captureOpenClawStateReadContext,
  captureOpenClawStateWorkerContext,
} from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { createSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";
import {
  mutateUserGitHubConnection,
  prepareUserGitHubConnection,
} from "./user-github-connections.js";
import { disconnectedUserGitHubConnection } from "./user-github-connections.kernel.js";
import { updateUserGitHubConnection } from "./user-github-connections.test-support.js";
import { ensureProfileForEmail } from "./user-profiles.js";

let context: OpenClawStateWorkerContext;
let root: string;
const scopes = new Set<ReturnType<typeof createGitHubPublicationWorkerScope>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
    vi.unstubAllEnvs();
    cleanup();
  }),
);
beforeAll(() => {
  root = tempDirs.make("openclaw-publication-worker-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const options = {
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  };
  openOpenClawStateDatabase(options);
  context = captureOpenClawStateWorkerContext(options);
});
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  setRuntimeConfigSnapshot({});
});
afterEach(async () => {
  releaseHeldGitHubPublicationMessages();
  vi.restoreAllMocks();
  await Promise.all([...scopes].map((scope) => scope.close()));
  scopes.clear();
  clearRuntimeConfigSnapshot();
});

function createScope(owner = context) {
  const scope = createGitHubPublicationWorkerScope(owner);
  scopes.add(scope);
  return scope;
}
function command(input: RepositoryPublicationMutation) {
  return {
    type: "githubPublications.repository" as const,
    input: {
      ...input,
      operationId: `${input.operation}-${"row" in input ? input.row.request_id : "report"}`,
    },
  };
}
function seed(id: string) {
  const row = repositoryRow(id);
  runOpenClawStateWriteTransaction(
    (database) =>
      insertRepositoryGitHubPublicationInDatabase(database, row, context.admission.assertCurrent),
    { path: context.admission.databasePath },
  );
  return row;
}
function read(row: RepositoryPublicationRow) {
  // Observe the durable commit independently while the ordinary worker reply is withheld.
  return withExistingOpenClawStateDatabaseCurrentReadOnly(
    ({ db }) => ({
      ok: true,
      rows: listRepositoryGitHubPublicationsInDatabase(db, { idempotencyKey: row.idempotency_key }),
    }),
    { path: context.admission.databasePath, allowNativeRead: true },
  );
}

function observeAuthority() {
  const facts = new Map<string, unknown>();
  const unknown: Array<string | symbol> = [];
  onTestFinished(
    githubPublicationReceipts.subscribeFacts((change) => {
      if (change.kind === "committed") {
        for (const [key, fact] of change.receipt.facts) {
          facts.set(key, fact);
        }
      } else if (change.kind === "unknown") {
        unknown.push(change.identity);
      }
    }),
  );
  return { facts, unknown };
}

function repositoryRow(requestId: string): RepositoryPublicationRow {
  const row: RepositoryPublicationRow = {
    request_id: requestId,
    idempotency_key: requestId,
    request_digest: "",
    requester_authority_json: null,
    session_id: "publication-worker-session",
    session_lifecycle_revision: null,
    session_key: "agent:main:publication-worker",
    agent_id: "main",
    workspace_id: "publication-worker-workspace",
    owner_profile_id: null,
    connection_generation: null,
    identity_source: "system-configured",
    identity_profile_id: "fixture-profile",
    identity_account_id: 42,
    identity_login: "fixture-bot",
    title: null,
    body: null,
    push_repository: "example/repository",
    repository: "example/repository",
    base_branch: "main",
    branch: "openclaw/worker-proof",
    previous_head_commit: null,
    claim_id: null,
    run_id: null,
    environment_id: null,
    owner_epoch: null,
    placement_generation: null,
    checkpoint_ref: "refs/openclaw/worker-results/fixture",
    checkpoint_digest: `sha256:${"a".repeat(64)}`,
    source_head_commit: "b".repeat(40),
    source_index_tree: "c".repeat(40),
    workspace_tree: "c".repeat(40),
    status: "requested",
    execution_id: null,
    gateway_instance_id: null,
    head_commit: null,
    pushed_head_commit: null,
    pull_request_url: null,
    last_effect: null,
    effect_state: null,
    error_code: null,
    next_action: null,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    reported_at_ms: null,
  };
  row.request_digest = repositoryGitHubPublicationDigest(row);
  return row;
}

async function sourceFixture(
  requestId: string,
  assertCurrent = () => {},
  personalOwnerProfileId?: string,
) {
  const row = repositoryRow(requestId);
  row.session_id = requestId;
  row.session_key = `agent:main:${requestId}`;
  const result = runOpenClawStateWriteTransaction(
    ({ db }) =>
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
    { path: context.admission.databasePath },
  );
  row.workspace_id = result.workspaceId;
  row.request_digest = repositoryGitHubPublicationDigest(row);
  const entry = await upsertSessionEntryCore(
    { agentId: row.agent_id, sessionKey: row.session_key },
    {
      sessionId: row.session_id,
      updatedAt: 1000,
      repositoryWorkspaceId: row.workspace_id,
    },
  );
  if (!entry) {
    throw new Error("Publication source session was not created");
  }
  row.session_lifecycle_revision = entry.lifecycleRevision ?? null;
  row.request_digest = repositoryGitHubPublicationDigest(row);
  const source = await prepareGitHubPublicationSource({
    sourcePath: resolveOpenClawAgentSqlitePath({ agentId: row.agent_id }),
    selector: {
      agentId: row.agent_id,
      sessionKey: row.session_key,
      sessionId: row.session_id,
      lifecycleRevision: row.session_lifecycle_revision,
      repositoryWorkspaceId: row.workspace_id,
      repositoryBranch: row.branch,
      personalOwnerProfileId,
    },
    signal: new AbortController().signal,
    assertCurrent,
  });
  return { row, source };
}

it("creates the lazy shared schema and publishes lifecycle authority before its first insert reply", async ({
  signal,
}) => {
  const request = {
    sessionKey: "agent:main:first-shared-publication",
    agentId: "main",
    idempotencyKey: "first-shared-publication",
  };
  const worktree = {
    id: "first-shared-publication-worktree",
    repoRoot: "/publication-repository",
    repoFingerprint: "publication-repository-fingerprint",
    branch: "openclaw/first-publication",
    baseRef: "origin/main",
  };
  await insertRegistryWorktree(process.env, {
    ...worktree,
    name: "first-publication",
    path: "/publication-repository/worktree",
    ownerKind: "session",
    ownerId: request.sessionKey,
    createdAt: 1000,
    lastActiveAt: 1000,
  });
  const sessionId = "first-shared-publication-session";
  const entry = await upsertSessionEntryCore(request, {
    sessionId,
    updatedAt: 1000,
    worktree: { id: worktree.id, repoRoot: worktree.repoRoot, branch: worktree.branch },
  });
  const lifecycleRevision = entry?.lifecycleRevision ?? null;
  const db = openOpenClawStateDatabase().db;
  db.exec("DROP TABLE IF EXISTS github_publication_requests");
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name = 'github_publication_requests'").get(),
  ).toBeUndefined();
  const source = await prepareGitHubPublicationSource({
    sourcePath: resolveOpenClawAgentSqlitePath({ agentId: request.agentId }),
    selector: {
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      sessionId,
      lifecycleRevision,
      worktreeId: worktree.id,
    },
    signal: new AbortController().signal,
    assertCurrent: context.admission.assertCurrent,
  });
  const lifecycle = await prepareGitHubPublicationSessionLifecycle({
    publicationKind: "shared",
    requestId: "first-shared-publication-request",
  });
  expect(lifecycle.readCurrent()).toBeUndefined();
  const committed = createDeferredCore();
  let atSettlement: ReturnType<typeof lifecycle.readCurrent>;
  onTestFinished(
    githubPublicationReceipts.subscribeFacts((change) => {
      if (
        change.kind === "committed" &&
        change.receipt.source.identity === context.admission.identity.key
      ) {
        expect(lifecycle.readCurrent).toThrow("lifecycle authority is unavailable");
        committed.resolve();
      }
      if (change.kind === "settled" && change.identity === context.admission.identity.key) {
        atSettlement = captureGitHubPublicationLifecycle(captureOpenClawStateReadContext(), {
          publicationKind: "shared",
          requestId: "first-shared-publication-request",
        }).readCurrent();
      }
    }),
  );
  const reply = holdNextReply("githubPublications.insert", () => {
    // An uncommitted insert cannot authorize publication from a missing binding.
    expect(lifecycle.readCurrent()).toBeUndefined();
  });
  const inserting = insertGitHubPublicationRequestAsync(
    {
      request,
      requestId: "first-shared-publication-request",
      requestDigest: digestGitHubPublicationRequest({ ...request, sessionId }),
      sessionId,
      lifecycleRevision,
      requester: { version: 1, actor: { kind: "system" }, scopes: ["operator.admin"], grant: null },
      now: 1000,
      worktree,
      identity: {
        source: "system-configured",
        profileId: "fixture-profile",
        account: { accountId: 42, login: "fixture-bot", avatarUrl: null },
      },
    },
    source,
  );
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        Promise.all([reply.ready, committed.promise]),
        inserting,
        "lifecycle publication did not precede its insert reply",
      ),
      signal,
    );
    expect(lifecycle.readCurrent).toThrow("lifecycle authority is unavailable");
  } finally {
    reply.release();
  }
  const inserted = await inserting;
  expect(inserted).toMatchObject({
    request_id: "first-shared-publication-request",
    status: "requested",
  });
  expect(lifecycle.readCurrent).toThrow("lifecycle authority is unavailable");
  if (!atSettlement) {
    throw new Error("Publication authority did not settle");
  }
  const sql = observeMainThreadSql();
  const requests = vi.spyOn(Worker.prototype, "postMessage");
  try {
    sql.calibrate();
    const expected = {
      lifecycle_revision: lifecycleRevision,
      requester_authority_json:
        '{"version":1,"actor":{"kind":"system"},"scopes":["operator.admin"],"grant":null}',
    };
    expect(atSettlement).toEqual(expected);
    expect(
      (
        await prepareGitHubPublicationSessionLifecycle({
          publicationKind: "shared",
          requestId: inserted.request_id,
        })
      ).readCurrent(),
    ).toEqual(expected);
    sql.expectIdle();
    expect(requests).not.toHaveBeenCalled();
  } finally {
    sql.restore();
    requests.mockRestore();
  }
  await expect(
    readGitHubPublicationRequestAsync({ requestId: inserted.request_id }),
  ).resolves.toEqual(inserted);
});

it("does not cancel a newer personal GitHub authorization", async () => {
  const owner = ensureProfileForEmail("publication-cancel@example.test").id;
  const first = "09208f47-f654-4120-a878-bbed310e02d1";
  const second = "bf6714e1-ce2d-44c8-beb3-4b895b2c48d7";
  const createdAtMs = Date.now();
  for (const requestId of [first, second]) {
    await mutateUserGitHubConnection(
      owner,
      {
        kind: "start",
        requestId,
        createdAtMs,
        expiresAtMs: createdAtMs + 900000,
      },
      () => {},
    );
  }
  expect(
    await mutateUserGitHubConnection(owner, { kind: "cancel", requestId: first }, () => {}),
  ).toBeUndefined();
  expect((await prepareUserGitHubConnection(owner)).read()?.pending?.requestId).toBe(second);
});

it("revokes personal source authority at commit before reply delivery without reviving restored state", async ({
  signal,
}) => {
  const owner = ensureProfileForEmail("publication-source@example.test").id;
  const original = await mutateUserGitHubConnection(owner, { kind: "disconnect" }, () => {});
  if (!original) {
    throw new Error("Connection fixture missing");
  }
  const connection = await prepareUserGitHubConnection(owner);
  const { row, source } = await sourceFixture("source-connection-revocation", () => {}, owner);
  try {
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        updateUserGitHubConnection(owner, disconnectedUserGitHubConnection, () => {});
        throw new Error("rollback connection");
      }),
    ).toThrow("rollback connection");
    expect(() => bindGitHubPublicationSource(source)).not.toThrow();
    expect(() => connection.read()).not.toThrow();
    const receipt = holdNextReceipt();
    const reply = holdNextReply("userGitHubConnections.mutate");
    const disconnected = mutateUserGitHubConnection(owner, { kind: "disconnect" }, () => {});
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([receipt.ready, reply.ready]),
          disconnected,
          "connection receipt and reply were not held",
        ),
        signal,
      );
      // Receipt and reply use separate ports; deliver the real commit facts before asserting.
      receipt.release();
      expect(() => bindGitHubPublicationSource(source)).toThrow("source authority changed");
      expect(() => connection.read()).toThrow("My GitHub connection changed");
    } finally {
      receipt.release();
      reply.release();
      await disconnected;
    }
    updateUserGitHubConnection(
      owner,
      () => original,
      () => {},
    );
    expect(() => connection.read()).toThrow("My GitHub connection changed");
    expect((await prepareUserGitHubConnection(owner)).read()).toEqual(original);
    await expect(insertRepositoryGitHubPublicationAsync(row, source)).rejects.toThrow(
      "source authority changed",
    );
    expect(read(row)).toMatchObject({ ok: true, rows: [] });
  } finally {
    await source.release();
  }
});

it("rejects a cold personal connection read overtaken by disconnect", async ({ signal }) => {
  const owner = ensureProfileForEmail("publication-cold-disconnect@example.test").id;
  const readReady = createDeferredCore();
  const release = createDeferredCore();
  const executeRead = stateReads.executeExistingOpenClawStateRead;
  const delayedRead: typeof executeRead = async (options, operation, readOptions) => {
    const result = await executeRead(options, operation, readOptions);
    if (operation.type === "userGitHubConnections.read") {
      readReady.resolve();
      await release.promise;
    }
    return result;
  };
  const reads = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation(delayedRead);
  const preparing = prepareUserGitHubConnection(owner);
  const rejected = expect(preparing).rejects.toThrow("My GitHub connection changed");
  try {
    await withinTest(
      awaitGateBeforeSettlement(readReady.promise, preparing, "cold connection read was not held"),
      signal,
    );
    await mutateUserGitHubConnection(owner, { kind: "disconnect" }, () => {});
  } finally {
    release.resolve();
    reads.mockRestore();
  }
  await rejected;
  expect((await prepareUserGitHubConnection(owner)).read()?.selection.kind).toBe("disconnected");
});

it("revokes cached personal authority when a committed disconnect loses its receipt", async ({
  signal,
}) => {
  const owner = ensureProfileForEmail("publication-lost-receipt@example.test").id;
  updateUserGitHubConnection(
    owner,
    () => ({
      ...disconnectedUserGitHubConnection(),
      selection: {
        kind: "connected",
        profileId: "ghp_0123456789abcdef0123456789abcdef",
        accountId: 42,
        login: "fixture-user",
        refreshToken: "synthetic-refresh",
        accessExpiresAtMs: 1000,
        refreshExpiresAtMs: 2000,
        scopes: ["repo"],
      },
    }),
    () => {},
  );
  const connection = await prepareUserGitHubConnection(owner);
  const { source } = await sourceFixture("source-lost-connection-receipt", () => {}, owner);
  const receipt = holdNextReceipt();
  const reply = holdNextReply("userGitHubConnections.mutate");
  const disconnected = mutateUserGitHubConnection(owner, { kind: "disconnect" }, () => {});
  const refused = expect(disconnected).rejects.toThrow("connection write outcome is unknown");
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        Promise.all([receipt.ready, reply.ready]),
        disconnected,
        "connection receipt and reply were not held",
      ),
      signal,
    );
    reply.release(new Error("connection write outcome is unknown"));
    await refused;
    expect(() => connection.read()).toThrow("My GitHub connection changed");
    expect(() => bindGitHubPublicationSource(source)).toThrow("source authority changed");
    expect((await prepareUserGitHubConnection(owner)).read()?.selection.kind).toBe("disconnected");
  } finally {
    receipt.release();
    reply.release();
    await source.release();
  }
});

it("runs policy writes before source reservation and refuses the changed source", async () => {
  let mutate: (() => void) | undefined;
  const { row, source } = await sourceFixture("source-policy-write", () => {
    const write = mutate;
    mutate = undefined;
    write?.();
  });
  mutate = () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare(
          "UPDATE session_repository_workspaces SET revision = revision + 1 WHERE workspace_id = ?",
        ).run(row.workspace_id);
      },
      { path: context.admission.databasePath },
    );
  try {
    await expect(insertRepositoryGitHubPublicationAsync(row, source)).rejects.toThrow(
      "source authority changed",
    );
    expect(read(row)).toMatchObject({ ok: true, rows: [] });
  } finally {
    await source.release();
  }
});

it("rejects a requested branch that does not belong to the captured source", async () => {
  const { row, source } = await sourceFixture("source-row-mismatch");
  row.branch = "openclaw/unrelated-branch";
  row.request_digest = repositoryGitHubPublicationDigest(row);
  try {
    await expect(insertRepositoryGitHubPublicationAsync(row, source)).rejects.toThrow(
      "requested repository changed",
    );
    expect(read(row)).toMatchObject({ ok: true, rows: [] });
  } finally {
    await source.release();
  }
});

it("does not use one session's source authority for another session's publication", async () => {
  const first = await sourceFixture("source-session-a");
  const second = await sourceFixture("source-session-b");
  const scope = createScope();
  try {
    await insertRepositoryGitHubPublicationAsync(second.row, second.source);
    await expect(
      scope.mutate(
        command({
          operation: "checkpoint",
          row: second.row,
          checkpoint: {
            checkpoint_ref: second.row.checkpoint_ref,
            checkpoint_digest: second.row.checkpoint_digest,
            source_head_commit: second.row.source_head_commit,
            source_index_tree: second.row.source_index_tree,
            workspace_tree: second.row.workspace_tree,
          },
        }),
        context.admission.assertCurrent,
        () => {},
        first.source,
      ),
    ).rejects.toThrow("source");
    expect(read(second.row)).toMatchObject({ ok: true, rows: [{ last_effect: null }] });
  } finally {
    await first.source.release();
    await second.source.release();
  }
});

it("publishes a committed receipt before a delayed ordinary worker reply", async ({ signal }) => {
  const scope = createScope();
  const row = seed("delayed-reply");
  const reply = holdNextReply();
  const { facts } = observeAuthority();
  const authorityAtNotification: unknown[] = [];
  const key = JSON.stringify(["repository", row.request_id]);
  const committed = createDeferredCore();
  const published = vi.fn((_receipt: PublicationMutationReceipt) => {
    authorityAtNotification.push(facts.get(key));
    committed.resolve();
  });
  const claim = scope.mutate(
    command({ operation: "claim", row, instanceId: "gateway", executionId: "execution" }),
    context.admission.assertCurrent,
    published,
  );
  await withinTest(
    awaitGateBeforeSettlement(
      Promise.all([reply.ready, committed.promise]),
      claim,
      "claim reply was not held through publication",
    ),
    signal,
  );
  expect(published).toHaveBeenCalledTimes(1);
  expect(authorityAtNotification).toMatchObject([
    {
      kind: "postimage",
      value: { request_id: row.request_id, status: "publishing", execution_id: "execution" },
    },
  ]);
  expect(published.mock.calls[0]?.[0]).toMatchObject({
    kind: "repository",
    rows: [{ request_id: row.request_id, status: "publishing", execution_id: "execution" }],
  });
  const durable = read(row);
  expect(durable).toMatchObject({
    ok: true,
    rows: [{ request_id: row.request_id, status: "publishing" }],
  });
  reply.release();
  await expect(claim).resolves.toMatchObject({ rows: [{ status: "publishing" }] });
  await scope.mutate(
    command({
      operation: "complete",
      row,
      instanceId: "gateway",
      executionId: "execution",
      result: {
        requestId: row.request_id,
        status: "failed",
        code: "no_changes",
        message: "No changes to publish",
        nextAction: "Retry publication",
      },
    }),
    context.admission.assertCurrent,
    () => {},
  );
  await expect(
    runGitHubPublicationMaintenanceAsync({ operation: "report", requestId: row.request_id }),
  ).resolves.toBeUndefined();
  expect(read(row)).toMatchObject({
    ok: true,
    rows: [{ reported_at_ms: expect.any(Number) }],
  });
});

it.for(["superseded", "closed"] as const)(
  "fences a late authority receipt after its owner is %s",
  async (outcome, { signal }) => {
    const lifecycleInput = {
      publicationKind: "shared" as const,
      requestId: `late-${outcome}-lifecycle`,
    };
    runOpenClawStateWriteTransaction(({ db }) =>
      insertGitHubPublicationSessionLifecycle(db, {
        ...lifecycleInput,
        lifecycleRevision: "original-revision",
      }),
    );
    const lifecycle = await prepareGitHubPublicationSessionLifecycle(lifecycleInput);
    let closed = false;
    const scope = createScope({
      ...context,
      assertPublicationCurrent: () => {
        if (closed) {
          throw new Error("Synthetic publication owner closed");
        }
        (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
      },
    });
    const row = seed(`late-${outcome}`);
    const { facts, unknown } = observeAuthority();
    const key = JSON.stringify(["repository", row.request_id]);
    const receipt = holdNextReceipt();
    const reply = holdNextReply();
    const published = vi.fn();
    const claim = scope.mutate(
      command({ operation: "claim", row, instanceId: "gateway", executionId: "original" }),
      context.admission.assertCurrent,
      published,
    );
    await withinTest(
      awaitGateBeforeSettlement(
        Promise.all([receipt.ready, reply.ready]),
        claim,
        "claim receipt was not held",
      ),
      signal,
    );
    if (outcome === "superseded") {
      runOpenClawStateWriteTransaction((database) =>
        claimRepositoryGitHubPublicationInDatabase(
          database,
          {
            ...row,
            status: "publishing",
            execution_id: "original",
            gateway_instance_id: "gateway",
          },
          "gateway",
          "replacement",
          {
            assertCurrent: context.admission.assertCurrent,
            assertCustody: context.admission.assertCurrent,
          },
        ),
      );
      expect(facts.get(key)).toMatchObject({
        kind: "postimage",
        value: { execution_id: "replacement" },
      });
      receipt.release();
      expect(facts.get(key)).toEqual({ kind: "unknown" });
      expect(published).toHaveBeenCalledTimes(1);
    } else {
      closed = true;
      expect(receipt.release).toThrow("publication owner closed");
      expect(facts.has(key)).toBe(false);
      expect(unknown).toContain(context.admission.identity.key);
      expect(published).not.toHaveBeenCalled();
    }
    reply.release();
    await expect(claim).resolves.toMatchObject({ rows: [{ execution_id: "original" }] });
    expect(read(row)).toMatchObject({
      ok: true,
      rows: [{ execution_id: outcome === "superseded" ? "replacement" : "original" }],
    });
    if (outcome === "closed") {
      expect(lifecycle.readCurrent).toThrow("lifecycle authority is unavailable");
      await expect(prepareGitHubPublicationSessionLifecycle(lifecycleInput)).rejects.toThrow(
        "lifecycle authority is unavailable",
      );
      await expect(prepareGitHubPublicationSessionLifecycle(lifecycleInput)).rejects.toThrow(
        "lifecycle authority is unavailable",
      );
    } else {
      expect(lifecycle.readCurrent()).toEqual({
        lifecycle_revision: "original-revision",
        requester_authority_json: null,
      });
    }
  },
);

it("revokes prepared sources when canonical deletion commits before its ordinary reply", async ({
  signal,
}) => {
  const { row, source } = await sourceFixture("source-receipt-deletion");
  try {
    runOpenClawStateWriteTransaction((database) =>
      insertRepositoryGitHubPublicationInDatabase(database, row, context.admission.assertCurrent),
    );
    const remove = await preparePersonalGitHubSessionReceiptDeletion({
      agentId: row.agent_id,
      generations: [
        {
          sessionKey: row.session_key,
          sessionId: row.session_id,
          lifecycleRevision: row.session_lifecycle_revision,
        },
      ],
    });
    expect(() => bindGitHubPublicationSource(source)).not.toThrow();
    const installed = createDeferredCore();
    onTestFinished(
      githubPublicationReceipts.subscribeFacts((change) => {
        if (
          change.kind === "committed" &&
          change.receipt.source.identity === context.admission.identity.key &&
          change.receipt.facts.get(JSON.stringify(["repository", row.request_id]))?.kind ===
            "absent"
        ) {
          installed.resolve();
        }
      }),
    );
    const reply = holdNextReply("githubPublication.deleteSessionReceipts");
    let checkedBeforeCommit = false;
    sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "commit") {
        checkedBeforeCommit = true;
        expect(() => bindGitHubPublicationSource(source)).toThrow("source authority changed");
      }
      admit(request, grant);
    });
    const deletion = remove();
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([reply.ready, installed.promise]),
          deletion,
          "deletion receipt was not installed before its reply",
        ),
        signal,
      );
      expect(checkedBeforeCommit).toBe(true);
      expect(() => bindGitHubPublicationSource(source)).toThrow("source authority changed");
    } finally {
      reply.release();
      await deletion;
    }
    expect(read(row)).toMatchObject({ ok: true, rows: [] });
    runOpenClawStateWriteTransaction((database) =>
      insertRepositoryGitHubPublicationInDatabase(database, row, context.admission.assertCurrent),
    );
    expect(() => bindGitHubPublicationSource(source)).toThrow("source authority changed");
  } finally {
    await source.release();
  }
});

it("settles execution bookkeeping without source authority while distinguishing observed effects", async () => {
  const row = seed("observed-effect");
  const execution = await claimRepositoryGitHubPublicationAsync(row, "gateway", {
    assertCustody: context.admission.assertCurrent,
    assertAction() {
      throw new Error("No action authority");
    },
    async prepareSource() {
      throw new Error("No source authority");
    },
  });
  await execution.updateHead("d".repeat(40));
  await execution.recordEffect("push");
  expect(read(row)).toMatchObject({
    ok: true,
    rows: [{ effect_state: "dispatched", pushed_head_commit: null }],
  });
  await execution.recordEffect("push", { headCommit: "d".repeat(40) });
  await execution.interrupt();
  expect(read(row)).toMatchObject({
    ok: true,
    rows: [
      {
        status: "requested",
        last_effect: "push",
        effect_state: "observed",
        pushed_head_commit: "d".repeat(40),
      },
    ],
  });
});

it("refuses delayed observation from an execution replaced by a later claim", async () => {
  const scope = createScope();
  const row = seed("replaced-execution");
  const original = { row, instanceId: "gateway", executionId: "original" };
  const receipt = await scope.mutate(
    command({ operation: "claim", ...original }),
    context.admission.assertCurrent,
    () => undefined,
  );
  if (receipt.kind !== "repository" || !receipt.rows[0]) {
    throw new Error("Repository receipt missing");
  }
  await scope.mutate(
    command({
      operation: "claim",
      row: receipt.rows[0],
      instanceId: "gateway",
      executionId: "replacement",
    }),
    context.admission.assertCurrent,
    () => undefined,
  );
  await expect(
    scope.mutate(
      command({
        operation: "recordEffect",
        effect: "push",
        observed: { headCommit: "e".repeat(40) },
        ...original,
      }),
      context.admission.assertCurrent,
      () => undefined,
    ),
  ).rejects.toThrow("no longer current");
  expect(read(row)).toMatchObject({
    ok: true,
    rows: [{ execution_id: "replacement", pushed_head_commit: null }],
  });
});

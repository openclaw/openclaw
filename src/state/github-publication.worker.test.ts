import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { personalGitHubRequestDigest } from "../gateway/github-personal-publication-store.js";
import {
  insertPersonalGitHubPublicationInDatabase,
  type PersonalGitHubPublicationRow,
} from "../gateway/github-personal-publication-store.worker.js";
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
  readGitHubPublicationRequestAsync,
  runGitHubPublicationMaintenanceAsync,
} from "../gateway/github-publication-store-async.js";
import { listRepositoryGitHubPublicationsInDatabase } from "../gateway/github-repository-publication-read.worker.js";
import { insertRepositoryGitHubPublicationInDatabase } from "../gateway/github-repository-publication-store.worker.js";
import { repositoryGitHubPublicationDigest } from "../gateway/github-repository-publication.kernel.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "./github-personal-publication-lifecycle.js";
import {
  holdStateRead,
  observePublicationAuthority,
  publicationRowDefaults,
  waitForPublicationGate,
} from "./github-publication-fixtures.test-support.js";
import type { RepositoryGitHubPublicationRow as RepositoryPublicationRow } from "./github-publication-read.types.js";
import { githubPublicationReceipts } from "./github-publication-receipts.js";
import { prepareGitHubPublicationSessionLifecycle } from "./github-publication-session-lifecycles.js";
import {
  insertGitHubPublicationSessionLifecycle,
  readGitHubPublicationSessionLifecycle,
} from "./github-publication-session-lifecycles.worker.js";
import { createGitHubPublicationWorkerScope } from "./github-publication-worker.js";
import type {
  PublicationMutationReceipt,
  RepositoryPublicationMutation,
} from "./github-publication-worker.types.js";
import {
  expectNoMainThreadSql,
  expectNoWorkerRequests,
  publicationCommand as command,
  repositoryRow,
  holdNextReceipt,
  holdNextReply,
  releaseHeldGitHubPublicationMessages,
} from "./github-publication.worker.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { createSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";
import {
  listUserGitHubConnectionsAsync,
  mutateUserGitHubConnection,
  prepareUserGitHubConnection,
} from "./user-github-connections.js";
import { disconnectedUserGitHubConnection } from "./user-github-connections.kernel.js";
import { updateUserGitHubConnection } from "./user-github-connections.test-support.js";
import { userGitHubConnectionSchema } from "./user-github-connections.types.js";
import { ensureProfileForEmail } from "./user-profiles.js";

let context: OpenClawStateWorkerContext;
let root: string;
const requester = {
  version: 1 as const,
  actor: { kind: "system" as const },
  scopes: ["operator.admin"],
  grant: null,
};
const requesterJson =
  '{"version":1,"actor":{"kind":"system"},"scopes":["operator.admin"],"grant":null}';
const scopes = new Set<ReturnType<typeof createGitHubPublicationWorkerScope>>();
const sources = new Set<Awaited<ReturnType<typeof prepareGitHubPublicationSource>>>();
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
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: root } };
  openOpenClawStateDatabase(options);
  context = captureOpenClawStateWorkerContext(options);
});
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  setRuntimeConfigSnapshot({});
});
afterEach(async () => {
  releaseHeldGitHubPublicationMessages();
  for (const source of sources) {
    await source.release();
  }
  sources.clear();
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
function seed(input: string | RepositoryPublicationRow) {
  const row = typeof input === "string" ? repositoryRow(input) : input;
  runOpenClawStateWriteTransaction(
    (database) =>
      insertRepositoryGitHubPublicationInDatabase(database, row, context.admission.assertCurrent),
    { path: context.admission.databasePath },
  );
  return row;
}

async function reopenWorker() {
  await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
  openOpenClawStateDatabase();
  context = captureOpenClawStateWorkerContext();
}
function read(row: RepositoryPublicationRow) {
  // Observe the durable commit independently while the ordinary worker reply is withheld.
  return withExistingOpenClawStateDatabaseCurrentReadOnly(
    ({ db }) =>
      listRepositoryGitHubPublicationsInDatabase(db, { idempotencyKey: row.idempotency_key }),
    { path: context.admission.databasePath, allowNativeRead: true },
  );
}

function observeAuthority() {
  const authority = observePublicationAuthority();
  onTestFinished(authority.stop);
  return authority;
}

function expectRows(row: RepositoryPublicationRow, rows: unknown[]) {
  expect(read(row)).toMatchObject(rows);
}

function mutatePublication(
  scope: ReturnType<typeof createScope>,
  input: RepositoryPublicationMutation,
  published: (receipt: PublicationMutationReceipt) => void = () => {},
) {
  return scope.mutate(command(input), context.admission.assertCurrent, published);
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
  const entry = await upsertSessionEntryCore(
    { agentId: row.agent_id, sessionKey: row.session_key },
    { sessionId: row.session_id, updatedAt: 1000, repositoryWorkspaceId: row.workspace_id },
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
  sources.add(source);
  return { row, source };
}

it("creates the lazy shared schema and replaces a missing lifecycle binding on insert", async () => {
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
  const inserted = await insertGitHubPublicationRequestAsync(
    {
      request,
      requestId: "first-shared-publication-request",
      requestDigest: digestGitHubPublicationRequest({ ...request, sessionId }),
      sessionId,
      lifecycleRevision,
      requester,
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
  expect(inserted).toMatchObject({
    request_id: "first-shared-publication-request",
    status: "requested",
  });
  expect(lifecycle.readCurrent).toThrow("lifecycle authority is unavailable");
  await expectNoMainThreadSql(() =>
    expectNoWorkerRequests(async () => {
      const expected = {
        lifecycle_revision: lifecycleRevision,
        requester_authority_json: requesterJson,
      };
      expect(
        (
          await prepareGitHubPublicationSessionLifecycle({
            publicationKind: "shared",
            requestId: inserted.request_id,
          })
        ).readCurrent(),
      ).toEqual(expected);
    }),
  );
  await expect(
    readGitHubPublicationRequestAsync({ requestId: inserted.request_id }),
  ).resolves.toEqual(inserted);
});

it("consumes validated connection replies without reparsing and keeps host redaction and isolation", async () => {
  const owner = ensureProfileForEmail("connection-readback@example.test").id;
  const now = Date.now();
  const deviceCode = "synthetic-device-code".padEnd(40, "x");
  const initial = updateUserGitHubConnection(
    owner,
    () => ({
      ...disconnectedUserGitHubConnection(),
      pending: {
        kind: "device",
        requestId: randomUUID(),
        deviceCode,
        userCode: "TEST-CODE",
        verificationUri: "https://github.com/login/device",
        createdAtMs: now,
        expiresAtMs: now + 900000,
        pollIntervalMs: 1000,
        nextPollAtMs: now + 1000,
      },
    }),
    () => {},
  );
  const parse = vi.spyOn(userGitHubConnectionSchema, "safeParse");
  resetSecretRedactionRegistryForTest();
  const prepared = await prepareUserGitHubConnection(owner);
  expect(prepared.read()).toEqual(initial);
  expect(isSecretValueRegisteredForRedaction(deviceCode)).toBe(true);
  const detached = prepared.read()!;
  detached.pending = undefined;
  expect(prepared.read()).toEqual(initial);

  resetSecretRedactionRegistryForTest();
  expect(await listUserGitHubConnectionsAsync()).toContainEqual({ owner, connection: initial });
  expect(isSecretValueRegisteredForRedaction(deviceCode)).toBe(true);

  resetSecretRedactionRegistryForTest();
  expect(
    await mutateUserGitHubConnection(owner, { kind: "expire", nowMs: now }, () => {}),
  ).toBeUndefined();
  const renewed = await mutateUserGitHubConnection(
    owner,
    {
      kind: "device",
      generation: initial.generation,
      requestId: initial.pending!.requestId,
      device: {
        ...initial.pending!,
        kind: "device",
        deviceCode,
        userCode: "TEST-CODE",
        verificationUri: "https://github.com/login/device",
        pollIntervalMs: 1000,
        nextPollAtMs: now + 2000,
      },
    },
    () => {},
  );
  expect(renewed?.pending).toMatchObject({ deviceCode, nextPollAtMs: now + 2000 });
  expect(isSecretValueRegisteredForRedaction(deviceCode)).toBe(true);
  expect(parse).not.toHaveBeenCalled();
  resetSecretRedactionRegistryForTest();
});

it("does not cancel a newer personal GitHub authorization", async () => {
  const owner = ensureProfileForEmail("publication-cancel@example.test").id;
  const first = "09208f47-f654-4120-a878-bbed310e02d1";
  const second = "bf6714e1-ce2d-44c8-beb3-4b895b2c48d7";
  const createdAtMs = Date.now();
  for (const requestId of [first, second]) {
    await mutateUserGitHubConnection(
      owner,
      { kind: "start", requestId, createdAtMs, expiresAtMs: createdAtMs + 900000 },
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
    await waitForPublicationGate(signal, disconnected, receipt.ready, reply.ready);
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
  expectRows(row, []);
});

it("rejects a cold personal connection read overtaken by disconnect", async ({ signal }) => {
  const owner = ensureProfileForEmail("publication-cold-disconnect@example.test").id;
  const heldRead = holdStateRead("userGitHubConnections.read");
  const preparing = prepareUserGitHubConnection(owner);
  const rejected = expect(preparing).rejects.toThrow("My GitHub connection changed");
  try {
    await waitForPublicationGate(signal, preparing, heldRead.ready);
    await mutateUserGitHubConnection(owner, { kind: "disconnect" }, () => {});
  } finally {
    heldRead.release();
    heldRead.restore();
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
    await waitForPublicationGate(signal, disconnected, receipt.ready, reply.ready);
    reply.release(new Error("connection write outcome is unknown"));
    await refused;
    expect(() => connection.read()).toThrow("My GitHub connection changed");
    expect(() => bindGitHubPublicationSource(source)).toThrow("source authority changed");
    expect((await prepareUserGitHubConnection(owner)).read()?.selection.kind).toBe("disconnected");
  } finally {
    receipt.release();
    reply.release();
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
  await expect(insertRepositoryGitHubPublicationAsync(row, source)).rejects.toThrow(
    "source authority changed",
  );
  expectRows(row, []);
});

it("rejects a requested branch that does not belong to the captured source", async () => {
  const { row, source } = await sourceFixture("source-row-mismatch");
  row.branch = "openclaw/unrelated-branch";
  row.request_digest = repositoryGitHubPublicationDigest(row);
  await expect(insertRepositoryGitHubPublicationAsync(row, source)).rejects.toThrow(
    "requested repository changed",
  );
  expectRows(row, []);
});

it("does not use one session's source authority for another session's publication", async () => {
  const first = await sourceFixture("source-session-a");
  const second = await sourceFixture("source-session-b");
  const scope = createScope();
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
  expectRows(second.row, [{ last_effect: null }]);
});

it.for(["delivered", "lost"] as const)(
  "publishes committed facts before a %s acknowledgement-only worker reply",
  async (delivery, { signal }) => {
    const scope = createScope();
    const candidate = {
      ...repositoryRow(`delayed-reply-${delivery}`),
      body: "Synthetic publication body. ".repeat(640),
    };
    candidate.request_digest = repositoryGitHubPublicationDigest(candidate);
    const row = seed(candidate);
    const reply = holdNextReply();
    const { facts } = observeAuthority();
    const key = JSON.stringify(["repository", row.request_id]);
    const committed = createDeferredCore();
    const published = vi.fn(() => {
      expect(facts.get(key)).toMatchObject({
        kind: "postimage",
        value: { request_id: row.request_id, status: "publishing", execution_id: "execution" },
      });
      committed.resolve();
    });
    const claim = mutatePublication(
      scope,
      { operation: "claim", row, instanceId: "gateway", executionId: "execution" },
      published,
    );
    await waitForPublicationGate(signal, claim, reply.ready, committed.promise);
    expect((await reply.ready).value.byteLength).toBeLessThan(16);
    expectRows(row, [{ request_id: row.request_id, status: "publishing" }]);
    reply.release(delivery === "lost" ? new Error("Synthetic worker reply loss") : undefined);
    await expect(claim).resolves.toMatchObject({
      rows: [{ status: "publishing", body: row.body }],
    });
    expect(published).toHaveBeenCalledOnce();
    await mutatePublication(scope, {
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
    });
    await expect(
      runGitHubPublicationMaintenanceAsync({ operation: "report", requestId: row.request_id }),
    ).resolves.toBeUndefined();
    expectRows(row, [{ reported_at_ms: expect.any(Number) }]);
  },
);

it("fences a late authority receipt after its owner closes", async ({ signal }) => {
  const lifecycleInput = {
    publicationKind: "shared" as const,
    requestId: "late-closed-lifecycle",
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
  const row = seed("late-closed");
  const { facts, unknown } = observeAuthority();
  const key = JSON.stringify(["repository", row.request_id]);
  const receipt = holdNextReceipt();
  const reply = holdNextReply();
  const published = vi.fn();
  const claim = mutatePublication(
    scope,
    { operation: "claim", row, instanceId: "gateway", executionId: "original" },
    published,
  );
  await waitForPublicationGate(signal, claim, receipt.ready, reply.ready);
  closed = true;
  expect(receipt.release).toThrow("publication owner closed");
  expect(facts.has(key)).toBe(false);
  expect(unknown).toContain(context.admission.identity.key);
  expect(published).not.toHaveBeenCalled();
  reply.release();
  await expect(claim).resolves.toMatchObject({ rows: [{ execution_id: "original" }] });
  expectRows(row, [{ execution_id: "original" }]);
  expect(lifecycle.readCurrent).toThrow("lifecycle authority is unavailable");
  await expect(prepareGitHubPublicationSessionLifecycle(lifecycleInput)).rejects.toThrow(
    "lifecycle authority is unavailable",
  );
});

it("revokes prepared sources when canonical deletion commits before its ordinary reply", async ({
  signal,
}) => {
  const { row, source } = await sourceFixture("source-receipt-deletion");
  seed(row);
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
        change.receipt.facts.get(JSON.stringify(["repository", row.request_id]))?.kind === "absent"
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
    await waitForPublicationGate(signal, deletion, reply.ready, installed.promise);
    expect(checkedBeforeCommit).toBe(true);
    expect(() => bindGitHubPublicationSource(source)).toThrow("source authority changed");
  } finally {
    reply.release();
    await deletion;
  }
  expectRows(row, []);
  seed(row);
  expect(() => bindGitHubPublicationSource(source)).toThrow("source authority changed");
});

it("refuses delayed observation from an execution replaced by a later claim", async () => {
  const scope = createScope();
  const row = seed("replaced-execution");
  const original = { row, instanceId: "gateway", executionId: "original" };
  const receipt = await mutatePublication(scope, { operation: "claim", ...original });
  if (receipt.kind !== "repository" || !receipt.rows[0]) {
    throw new Error("Repository receipt missing");
  }
  await mutatePublication(scope, {
    operation: "claim",
    row: receipt.rows[0],
    instanceId: "gateway",
    executionId: "replacement",
  });
  await expect(
    mutatePublication(scope, {
      operation: "recordEffect",
      effect: "push",
      observed: { headCommit: "e".repeat(40) },
      ...original,
    }),
  ).rejects.toThrow("no longer current");
  expectRows(row, [{ execution_id: "replacement", pushed_head_commit: null }]);
});

describe("retained publication lifecycle authority", () => {
  const receiptFault = useSqliteWorkerFault([
    {
      name: "fail_receipt_batch",
      match: /^delete from github_personal_publication_requests\b/u,
      sql: `CREATE TEMP TRIGGER fail_receipt_batch BEFORE DELETE ON main.github_personal_publication_requests
        WHEN OLD.request_id = '00000000-0000-4000-8000-000000000064'
        BEGIN SELECT RAISE(ABORT, 'synthetic receipt deletion failure'); END;`,
    },
  ]);
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
        context.admission.assertCurrent,
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
    // Retire earlier uninstrumented workers before this suite seeds its fault-enabled owner.
    await reopenWorker();
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
    await reopenWorker();
  });

  it("loads shared and personal revisions, retained NULL and missing rows through the worker", async () => {
    await expectNoMainThreadSql(async () => {
      for (const { revision, ...input } of lifecycleCases) {
        const binding = await prepareGitHubPublicationSessionLifecycle(input);
        const expected =
          revision === "missing"
            ? undefined
            : { lifecycle_revision: revision, requester_authority_json: requesterJson };
        expect(binding.readCurrent()).toEqual(expected);
        await expectNoWorkerRequests(async () => {
          expect((await prepareGitHubPublicationSessionLifecycle(input)).readCurrent()).toEqual(
            expected,
          );
          expect(binding.readCurrent()).toEqual(expected);
        });
      }
    });
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
    const heldRead = holdStateRead();
    const preparing = prepareGitHubPublicationSessionLifecycle(input);
    const rejected = expect(preparing).rejects.toThrow(unavailable);
    try {
      await waitForPublicationGate(signal, preparing, heldRead.ready);
      await remove();
      expect(durable(input.requestId)).toBeUndefined();
    } finally {
      heldRead.release();
    }
    await rejected;
    expect((await prepareGitHubPublicationSessionLifecycle(input)).readCurrent()).toBeUndefined();
  });

  it("rolls back receipt batches and publishes only the exact committed tombstones", async () => {
    const databasePath = context.admission.databasePath;
    await reopenWorker();
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
          context.admission.assertCurrent,
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
    context = captureOpenClawStateWorkerContext();
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
      context = captureOpenClawStateWorkerContext();
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
      context = captureOpenClawStateWorkerContext();
    }
  });
});

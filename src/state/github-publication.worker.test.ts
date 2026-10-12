import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { insertRepositoryGitHubPublicationAsync } from "../gateway/github-publication-request-async.js";
import {
  bindGitHubPublicationSource,
  prepareGitHubPublicationSource,
} from "../gateway/github-publication-source.js";
import {
  claimRepositoryGitHubPublicationAsync,
  runGitHubPublicationMaintenanceAsync,
} from "../gateway/github-publication-store-async.js";
import { listRepositoryGitHubPublicationsInDatabase } from "../gateway/github-repository-publication-read.worker.js";
import {
  claimRepositoryGitHubPublicationInDatabase,
  insertRepositoryGitHubPublicationInDatabase,
} from "../gateway/github-repository-publication-store.worker.js";
import { repositoryGitHubPublicationDigest } from "../gateway/github-repository-publication.kernel.js";
import type { SqliteWorkerReply, SqliteWorkerRequest } from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "./github-personal-publication-lifecycle.js";
import type { RepositoryGitHubPublicationRow as RepositoryPublicationRow } from "./github-publication-read.types.js";
import { githubPublicationReceipts } from "./github-publication-receipts.js";
import { createGitHubPublicationWorkerScope } from "./github-publication-worker.js";
import type {
  PublicationMutationReceipt,
  RepositoryPublicationMutation,
} from "./github-publication-worker.types.js";
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
import { mutateUserGitHubConnection } from "./user-github-connections.js";
import { disconnectedUserGitHubConnection } from "./user-github-connections.kernel.js";
import { updateUserGitHubConnection } from "./user-github-connections.test-support.js";
import { ensureProfileForEmail } from "./user-profiles.js";

let context: OpenClawStateWorkerContext;
let root: string;
const scopes = new Set<ReturnType<typeof createGitHubPublicationWorkerScope>>();
const heldReplies = new Set<() => void>();
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
beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", root));
afterEach(async () => {
  for (const release of heldReplies) {
    release();
  }
  vi.restoreAllMocks();
  await Promise.all([...scopes].map((scope) => scope.close()));
  scopes.clear();
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
function holdNextReply(commandType = "githubPublications.repository") {
  const ready = createDeferredCore();
  let deliver: (() => void) | undefined;
  let target: { worker: Worker; id: number } | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the posting Worker.
  const postMessage = Worker.prototype.postMessage;
  const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    ...args
  ) {
    if (request.type === "execute") {
      const workerCommand: unknown = deserialize(request.input);
      if (
        workerCommand &&
        typeof workerCommand === "object" &&
        "type" in workerCommand &&
        workerCommand.type === commandType
      ) {
        target = { worker: this, id: request.id };
        posts.mockRestore();
      }
    }
    return Reflect.apply(postMessage, this, [request, ...args]);
  });
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the emitting Worker.
  const emit = Worker.prototype.emit;
  const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    reply: SqliteWorkerReply,
  ) {
    if (event === "message" && this === target?.worker && reply.id === target.id && reply.ok) {
      messages.mockRestore();
      deliver = () => {
        Reflect.apply(emit, this, [event, reply]);
      };
      ready.resolve();
      return true;
    }
    return Reflect.apply(emit, this, [event, reply]);
  });
  const release = () => {
    const send = deliver;
    deliver = undefined;
    heldReplies.delete(release);
    send?.();
  };
  heldReplies.add(release);
  return { ready: ready.promise, release };
}

function holdNextReceipt() {
  const ready = createDeferredCore();
  let deliver: (() => void) | undefined;
  const observe = workerAdmission.observeSqliteWorkerCommittedFacts;
  vi.spyOn(workerAdmission, "observeSqliteWorkerCommittedFacts").mockImplementationOnce(
    (admission, observer) => {
      observe(admission, (receipt) => {
        deliver = () => observer(receipt);
        ready.resolve();
      });
    },
  );
  const release = () => {
    const send = deliver;
    deliver = undefined;
    heldReplies.delete(release);
    send?.();
  };
  heldReplies.add(release);
  return { ready: ready.promise, release };
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

it("inserts a repository request through its retained session source", async () => {
  const { facts } = observeAuthority();
  const { row, source } = await sourceFixture("source-insert");
  try {
    await expect(insertRepositoryGitHubPublicationAsync(row, source)).resolves.toEqual(row);
    expect(facts.get(JSON.stringify(["repository", row.request_id]))).toMatchObject({
      kind: "postimage",
      value: { request_id: row.request_id, status: "requested" },
    });
    expect(read(row)).toMatchObject({ ok: true, rows: [row] });
  } finally {
    await source.release();
  }
});

it("revokes personal source authority at commit before reply delivery without reviving restored state", async ({
  signal,
}) => {
  const owner = ensureProfileForEmail("publication-source@example.test").id;
  const original = await mutateUserGitHubConnection(owner, { kind: "disconnect" }, () => {});
  if (!original) {
    throw new Error("Connection fixture missing");
  }
  const { row, source } = await sourceFixture("source-connection-revocation", () => {}, owner);
  try {
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        updateUserGitHubConnection(owner, disconnectedUserGitHubConnection, () => {});
        throw new Error("rollback connection");
      }),
    ).toThrow("rollback connection");
    expect(() => bindGitHubPublicationSource(source)).not.toThrow();
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
    await expect(insertRepositoryGitHubPublicationAsync(row, source)).rejects.toThrow(
      "source authority changed",
    );
    expect(read(row)).toMatchObject({ ok: true, rows: [] });
  } finally {
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

import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  personalGitHubRequestDigest,
  type PersonalGitHubPublicationRow as PersonalPublicationRow,
} from "../gateway/github-personal-publication-store.js";
import { repositoryGitHubPublicationDigest } from "../gateway/github-repository-publication.kernel.js";
import type { SqliteWorkerReply } from "../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { RepositoryGitHubPublicationRow as RepositoryPublicationRow } from "./github-publication-read.types.js";
import { createGitHubPublicationWorkerScope } from "./github-publication-worker.js";
import type {
  PersonalPublicationMutation,
  RepositoryPublicationMutation,
} from "./github-publication-worker.types.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import { ensureCanonicalUserProfileForEmail } from "./user-profile-writes.js";

let context: OpenClawStateWorkerContext;
type Scope = ReturnType<typeof createGitHubPublicationWorkerScope>;
const scopes = new Set<Scope>();
const heldReplies = new Set<() => void>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
    cleanup();
  }),
);
beforeAll(() => {
  const root = tempDirs.make("openclaw-publication-worker-");
  const options = {
    path: path.join(root, "openclaw.sqlite"),
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  };
  openOpenClawStateDatabase(options);
  context = captureOpenClawStateWorkerContext(options);
});
afterEach(async () => {
  for (const release of heldReplies) {
    release();
  }
  vi.restoreAllMocks();
  await Promise.all([...scopes].map((owner) => owner.close()));
  scopes.clear();
});

function scope() {
  const owner = createGitHubPublicationWorkerScope(context);
  scopes.add(owner);
  return owner;
}
const current = () => {};
function command(input: RepositoryPublicationMutation, operationId: string = input.operation) {
  return { type: "githubPublications.repository" as const, input: { ...input, operationId } };
}
function read(row: RepositoryPublicationRow) {
  return executeExistingOpenClawStateRead(
    { path: context.admission.databasePath },
    { type: "githubPublications.repositoryList", input: { idempotencyKey: row.idempotency_key } },
    { context, current: true },
  );
}
async function seed(owner: Scope, id: string) {
  const row = repositoryRow(id);
  await owner.mutate(command({ operation: "insert", row }), current, current);
  return row;
}

function holdNextReply() {
  const ready = createDeferredCore();
  let deliver: (() => void) | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the emitting Worker.
  const emit = Worker.prototype.emit;
  const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    reply: SqliteWorkerReply,
  ) {
    if (event === "message" && reply.ok) {
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

it("fences before COMMIT and preserves publication order while independent reads stay available", async ({
  signal,
}) => {
  const owner = scope();
  const row = await seed(owner, "ordered");
  const execution = { row, instanceId: "gateway", executionId: "ordered-execution" };
  const reply = holdNextReply();
  const events: string[] = [];
  let commitGrants = 0;
  const create = operationAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
    (admit, attachment) =>
      create((request, grant) => {
        admit(request, () => {
          if (request.stage === "commit") {
            expect(() => owner.assertCurrent()).toThrow("pending");
            commitGrants += 1;
          }
          return grant();
        });
      }, attachment),
  );
  const claim = owner.mutate(command({ operation: "claim", ...execution }), current, () => {
    events.push("claim");
  });
  await withinTest(
    awaitGateBeforeSettlement(reply.ready, claim, "claim reply was not held"),
    signal,
  );
  const prepared = owner.prepare(
    {
      type: "githubPublications.prepareRepository",
      input: { idempotencyKey: row.idempotency_key },
    },
    current,
  );
  const head = "d".repeat(40);
  const flow = (async () => {
    const record = (
      values: Extract<RepositoryPublicationMutation, { operation: "record" }>["values"],
      label: string,
    ) =>
      owner.mutate(
        command({ operation: "record", ...execution, values, requireAction: true }, label),
        current,
        () => {
          events.push(label);
        },
      );
    await record({ head_commit: head }, "head");
    await record({ last_effect: "push", effect_state: "dispatched" }, "dispatched");
    owner.assertCurrent();
    events.push("command");
    await record(
      { last_effect: "push", effect_state: "observed", pushed_head_commit: head },
      "observed",
    );
    await record(
      { status: "published", pull_request_url: "https://github.com/example/repository/pull/1" },
      "terminal",
    );
  })();
  try {
    expect(await read(row)).toMatchObject({ rows: [{ status: "publishing", head_commit: null }] });
    expect(() => owner.assertCurrent()).toThrow("pending");
    expect(events).toEqual([]);
  } finally {
    reply.release();
  }
  await withinTest(Promise.all([claim, flow]), signal);
  expect(await prepared).toMatchObject([{ status: "publishing", head_commit: null }]);
  expect(events).toEqual(["claim", "head", "dispatched", "command", "observed", "terminal"]);
  expect(commitGrants).toBe(5);
  expect(await read(row)).toMatchObject({
    rows: [{ status: "published", pushed_head_commit: head }],
  });
  owner.assertCurrent();
});

it("rolls back revoked COMMIT admission without releasing another scope's failed publication fence", async () => {
  const held = scope();
  const revoked = scope();
  const first = await seed(held, "held");
  const second = await seed(revoked, "revoked");
  await expect(
    held.mutate(
      command({ operation: "claim", row: first, instanceId: "gateway", executionId: "held" }),
      current,
      () => {
        throw new Error("projection publication unavailable");
      },
    ),
  ).rejects.toThrow("projection publication unavailable");
  const publish = vi.fn();
  let commitRefused = false;
  await expect(
    revoked.mutate(
      command({ operation: "claim", row: second, instanceId: "gateway", executionId: "revoked" }),
      () => {
        try {
          revoked.assertCurrent();
        } catch {
          commitRefused = true;
          throw new Error("publication source revoked before COMMIT");
        }
      },
      publish,
    ),
  ).rejects.toThrow("publication source revoked before COMMIT");
  expect(commitRefused).toBe(true);
  expect(publish).not.toHaveBeenCalled();
  expect(await read(second)).toMatchObject({ rows: [{ status: "requested", execution_id: null }] });
  revoked.assertCurrent();
  expect(() => held.assertCurrent()).toThrow("pending");
  await held.close();
  expect(() => held.assertCurrent()).toThrow("closed");
});

it("recovers the exact COMMIT receipt once when the normal Worker reply cannot be decoded", async () => {
  const owner = scope();
  const row = await seed(owner, "lost-reply");
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the emitting Worker.
  const emit = Worker.prototype.emit;
  const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    reply: SqliteWorkerReply,
  ) {
    if (event === "message" && reply.ok) {
      messages.mockRestore();
      return Reflect.apply(emit, this, [event, { ...reply, value: new Uint8Array([0]) }]);
    }
    return Reflect.apply(emit, this, [event, reply]);
  });
  const publish = vi.fn();
  const receipt = await owner.mutate(
    command(
      { operation: "claim", row, instanceId: "gateway", executionId: "lost-reply" },
      "exact-claim",
    ),
    current,
    publish,
  );
  expect(receipt).toMatchObject({
    operationId: "exact-claim",
    kind: "repository",
    rows: [{ status: "publishing", execution_id: "lost-reply" }],
  });
  expect(publish).toHaveBeenCalledExactlyOnceWith(receipt);
  expect(await read(row)).toMatchObject({ rows: receipt.rows });
  owner.assertCurrent();
});

it("closes admission immediately and joins an accepted claim without publishing retired facts", async ({
  signal,
}) => {
  const owner = scope();
  const row = await seed(owner, "close-pending");
  const reply = holdNextReply();
  const publish = vi.fn();
  const claim = owner.mutate(
    command({ operation: "claim", row, instanceId: "gateway", executionId: "close-pending" }),
    current,
    publish,
  );
  await withinTest(
    awaitGateBeforeSettlement(reply.ready, claim, "claim reply was not held"),
    signal,
  );
  const queued = owner.prepare(
    {
      type: "githubPublications.prepareRepository",
      input: { idempotencyKey: row.idempotency_key },
    },
    current,
  );
  const refused = expect(queued).rejects.toThrow("closed");
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  try {
    expect(() => owner.assertCurrent()).toThrow("closed");
    expect(await read(row)).toMatchObject({ rows: [{ status: "publishing" }] });
    expect(closed).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  } finally {
    reply.release();
  }
  const [receipt] = await withinTest(Promise.all([claim, closing, refused]), signal);
  expect(closed).toBe(true);
  expect(publish).not.toHaveBeenCalled();
  expect(await read(row)).toMatchObject({ rows: receipt.rows });
});

it("preserves personal owner selection and exact claim, restart, and report postimages", async () => {
  const owner = scope();
  const profile = await ensureCanonicalUserProfileForEmail("publication-owner@example.test", {
    path: context.admission.databasePath,
    env: context.initializationEnvironment,
  });
  const source = repositoryRow("00000000-0000-4000-8000-000000000001");
  const row: PersonalPublicationRow = {
    request_id: source.request_id,
    idempotency_key: source.idempotency_key,
    request_digest: "",
    owner_profile_id: profile.id,
    connection_generation: "00000000-0000-4000-8000-000000000002",
    session_id: source.session_id,
    session_key: source.session_key,
    agent_id: source.agent_id,
    worktree_id: "personal-worktree",
    repository_fingerprint: "personal-repository-fingerprint",
    identity_source: "personal",
    identity_profile_id: "00000000-0000-4000-8000-000000000003",
    identity_account_id: source.identity_account_id,
    identity_login: source.identity_login,
    title: null,
    body: null,
    status: "requested",
    gateway_instance_id: null,
    execution_id: null,
    push_repository: "example/repository",
    repository: "example/repository",
    branch: source.branch,
    base_branch: "main",
    source_head_commit: source.source_head_commit!,
    source_index_tree: source.source_index_tree!,
    workspace_tree: source.workspace_tree!,
    head_commit: null,
    pull_request_url: null,
    error_code: null,
    next_action: null,
    last_effect: null,
    effect_state: null,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    reported_at_ms: null,
  };
  row.request_digest = personalGitHubRequestDigest(row);
  const write = (input: PersonalPublicationMutation) =>
    owner.mutate(
      { type: "githubPublications.personal", input: { ...input, operationId: input.operation } },
      current,
      current,
    );
  await write({ operation: "insert", row, lifecycleRevision: "personal-lifecycle" });
  const claimed = await write({
    operation: "claim",
    row,
    instanceId: "gateway",
    executionId: "00000000-0000-4000-8000-000000000004",
  });
  const readPersonal = () =>
    executeExistingOpenClawStateRead(
      { path: context.admission.databasePath },
      {
        type: "githubPublications.personalRead",
        input: { owner: profile.id, request: { requestId: row.request_id } },
      },
      { context, current: true },
    );
  expect(await readPersonal()).toMatchObject({ row: claimed.rows[0] });
  expect(claimed.rows[0]?.updated_at_ms).toBeGreaterThan(row.updated_at_ms);
  const restarted = await write({ operation: "restart", instanceId: "new-gateway" });
  expect(restarted).toMatchObject({ rows: [{ status: "needs_confirmation" }] });
  if (restarted.kind !== "personal" || !restarted.rows[0]) {
    throw new Error("Missing personal restart receipt");
  }
  const execution = {
    row: restarted.rows[0],
    instanceId: "new-gateway",
    executionId: "00000000-0000-4000-8000-000000000005",
  };
  await write({ operation: "claim", ...execution });
  await write({
    operation: "record",
    ...execution,
    values: { status: "failed", error_code: "unavailable", next_action: "Create a new request." },
    requireAction: false,
  });
  const reported = await write({ operation: "report", requestId: row.request_id });
  expect(reported).toMatchObject({
    rows: [{ status: "failed", reported_at_ms: expect.any(Number) }],
  });
  expect(await readPersonal()).toMatchObject({ row: reported.rows[0] });
});

it("joins actual Worker exit and never turns a COMMIT grant into a successful receipt", async ({
  signal,
}) => {
  const owner = scope();
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  const row = await seed(owner, "worker-exit");
  const worker = posts.mock.contexts.find((candidate) => candidate instanceof Worker);
  if (!(worker instanceof Worker)) {
    throw new Error("Canonical publication Worker was not captured");
  }
  posts.mockRestore();
  let exited: Promise<number> | undefined;
  let admission: operationAdmission.SqliteWorkerOperationAdmission | undefined;
  const create = operationAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
    (admit, attachment) => {
      admission = create((request, grant) => {
        admit(request, () => {
          const granted = grant();
          if (request.stage === "commit") {
            exited = worker.terminate();
          }
          return granted;
        });
      }, attachment);
      return admission;
    },
  );
  const publish = vi.fn();
  const outcome = await withinTest(
    owner
      .mutate(
        command({ operation: "claim", row, instanceId: "gateway", executionId: "worker-exit" }),
        current,
        publish,
      )
      .then(
        (receipt) => ({ receipt }),
        (error: unknown) => ({ error }),
      ),
    signal,
  );
  if (!exited) {
    throw new Error("Worker did not reach the COMMIT grant");
  }
  await withinTest(exited, signal);
  expect(worker.threadId).toBe(-1);
  if ("receipt" in outcome) {
    expect(admission?.committed?.facts).toEqual(outcome.receipt);
    expect(publish).toHaveBeenCalledExactlyOnceWith(outcome.receipt);
  } else {
    expect(admission?.committed).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(() => owner.assertCurrent()).toThrow("pending");
  }
  await owner.close();
  expect(() => owner.assertCurrent()).toThrow("closed");
});

it("returns exact deletion tombstones for captured and late matching lifecycle receipts", async () => {
  const owner = scope();
  const rows = ["captured", "late"].map((id) => {
    const row = Object.assign(repositoryRow(id), {
      session_key: "agent:main:deleted-publication",
      push_repository: id === "late" ? null : "example/repository",
    });
    row.request_digest = repositoryGitHubPublicationDigest(row);
    return row;
  });
  const first = rows[0]!;
  const selection = { agentId: first.agent_id, sessionKeys: [first.session_key] };
  await owner.mutate(command({ operation: "insert", row: first }), current, current);
  const receipts = await runOpenClawStateWorkerOperation(context, (worker) =>
    worker.execute({
      type: "githubPublication.prepareSessionReceiptDeletion",
      input: selection,
    }),
  );
  await owner.mutate(command({ operation: "insert", row: rows[1]! }), current, current);
  let commitFacts: unknown;
  let admission: operationAdmission.SqliteWorkerOperationAdmission | undefined;
  const deleted = await runOpenClawStateWorkerOperation(
    context,
    (worker) =>
      worker.execute({
        type: "githubPublication.deleteSessionReceipts",
        input: {
          ...selection,
          receipts,
          generations: [
            { sessionKey: first.session_key, sessionId: first.session_id, lifecycleRevision: null },
          ],
        },
      }),
    {
      createAdmission: () => {
        admission = operationAdmission.createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage === "commit") {
            commitFacts = request.facts;
          }
          grant();
        });
        return { admission, nativeLocations: [context.admission.databasePath] };
      },
    },
  );
  expect(deleted).toEqual(
    rows.map((row) => ({
      kind: "repository",
      requestId: row.request_id,
      requestDigest: row.request_digest,
      ownerProfileId: null,
      sessionId: row.session_id,
      sessionKey: row.session_key,
      agentId: row.agent_id,
      idempotencyKey: row.idempotency_key,
      workspaceId: row.workspace_id,
      branch: row.branch,
      pushRepository: row.push_repository,
    })),
  );
  expect(commitFacts).toEqual(deleted);
  expect(admission?.committed?.facts).toEqual(deleted);
  expect(await read(first)).toMatchObject({ rows: [] });
});

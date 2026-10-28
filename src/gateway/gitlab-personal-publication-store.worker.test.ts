import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  createGitLabManagedOAuthRecord,
  writeGitLabManagedOAuthRecord,
} from "../agents/gitlab-managed-records.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "../agents/worktrees/registry.js";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { PostgresSqlConnection } from "../infra/sql-connection.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { replaceUserGitLabConnection } from "../state/user-gitlab-connections.js";
import { disconnectedUserGitLabConnection } from "../state/user-gitlab-connections.kernel.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  managedGitLabPublicationGeneration,
  type GitLabPublicationPublisher,
} from "./gitlab-personal-publication-identity.js";
import {
  personalGitLabRequestDigest,
  type PersonalGitLabPublicationRow,
} from "./gitlab-personal-publication-store.js";
import {
  gitLabSharedPublisherPredicate,
  claimPersonalGitLabPublicationInDatabase,
  insertPersonalGitLabPublicationInDatabase,
  readPersonalGitLabPublicationInDatabase,
  readSharedGitLabPublicationInDatabase,
  requirePersonalGitLabPublicationConfirmationInDatabase,
  writePersonalGitLabPublicationInDatabase,
} from "./gitlab-personal-publication-store.worker.js";

const issuer = "https://gitlab.example.test";
const current = () => {};

it("fences the old execution after restart and replacement claim", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("gitlab-native-publication@example.test").id;
    const connection = await replaceUserGitLabConnection(
      owner,
      issuer,
      undefined,
      {
        ...disconnectedUserGitLabConnection(issuer),
        selection: {
          kind: "connected",
          account: { issuer, accountId: 42, login: "alice" },
          tokens: {
            accessToken: "test-access",
            refreshToken: "test-refresh",
            expiresAtMs: Date.now() + 3600000,
            scopes: ["api"],
          },
        },
      },
      current,
    );
    const now = Date.now();
    const row: PersonalGitLabPublicationRow = {
      request_id: randomUUID(),
      owner_profile_id: owner,
      issuer,
      connection_generation: connection.generation,
      idempotency_key: randomUUID(),
      request_digest: "",
      session_id: randomUUID(),
      session_key: "agent:main:test",
      agent_id: "main",
      session_lifecycle_revision: null,
      worktree_id: "worktree-test",
      repository_fingerprint: "fingerprint-test",
      identity_account_id: 42,
      identity_login: "alice",
      branch: "topic-test",
      receipt_json: JSON.stringify({
        target: {
          issuer,
          projectId: 12,
          projectPath: "org/repo",
          gitUrl: "https://gitlab.example.test/org/repo.git",
          webUrl: "https://gitlab.example.test/org/repo",
          baseBranch: "master",
        },
        actor: { accountId: 42, login: "alice" },
        sessionIdentity: {
          sessionId: "",
          sessionKey: "agent:main:test",
          agentId: "main",
          lifecycleRevision: null,
        },
        sourceId: "worktree-test",
        worktreeId: "worktree-test",
        repositoryFingerprint: "fingerprint-test",
        branch: "topic-test",
        sourceHead: "b".repeat(40),
        baseTree: "a".repeat(40),
        workspaceHead: "c".repeat(40),
        repositoryRoot: "/tmp/repo",
        sourceIndexTree: "a".repeat(40),
        createdAtMs: now,
      }),
      status: "requested",
      gateway_instance_id: null,
      execution_id: null,
      head_commit: null,
      pull_request_url: null,
      error_code: null,
      next_action: null,
      last_effect: null,
      effect_state: null,
      push_observation: null,
      result_json: null,
      created_at_ms: now,
      updated_at_ms: now,
      reported_at_ms: null,
    };
    row.receipt_json = JSON.stringify({
      ...JSON.parse(row.receipt_json),
      sessionIdentity: {
        sessionId: row.session_id,
        sessionKey: row.session_key,
        agentId: row.agent_id,
        lifecycleRevision: null,
      },
    });
    row.request_digest = personalGitLabRequestDigest(row);
    const mismatched = {
      ...row,
      receipt_json: row.receipt_json.replace('"login":"alice"', '"login":"mallory"'),
    };
    mismatched.request_digest = personalGitLabRequestDigest(mismatched);
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        insertPersonalGitLabPublicationInDatabase(database, mismatched, current),
      ),
    ).toThrow("accepted checkpoint is inconsistent");
    runOpenClawStateWriteTransaction((database) =>
      insertPersonalGitLabPublicationInDatabase(database, row, current),
    );
    const another = { ...row, request_id: randomUUID(), idempotency_key: randomUUID() };
    another.request_digest = personalGitLabRequestDigest(another);
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        insertPersonalGitLabPublicationInDatabase(database, another, current),
      ),
    ).toThrow("unresolved request");
    const first = runOpenClawStateWriteTransaction((database) =>
      claimPersonalGitLabPublicationInDatabase(
        database,
        row,
        "gateway-first",
        "execution-first",
        current,
      ),
    );
    expect(first.status).toBe("publishing");
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        claimPersonalGitLabPublicationInDatabase(
          database,
          row,
          "gateway-second",
          "execution-second",
          current,
        ),
      ),
    ).toThrow("execution changed");
    runOpenClawStateWriteTransaction((database) =>
      requirePersonalGitLabPublicationConfirmationInDatabase(database, "gateway-second"),
    );
    const interrupted = readPersonalGitLabPublicationInDatabase(
      openOpenClawStateDatabase().db,
      owner,
      issuer,
      { requestId: row.request_id },
    )!;
    expect(interrupted.status).toBe("needs_confirmation");
    const second = runOpenClawStateWriteTransaction((database) =>
      claimPersonalGitLabPublicationInDatabase(
        database,
        interrupted,
        "gateway-second",
        "execution-second",
        current,
      ),
    );
    expect(second.execution_id).toBe("execution-second");
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        writePersonalGitLabPublicationInDatabase(
          database,
          first,
          "gateway-first",
          "execution-first",
          { head_commit: "a".repeat(40) },
        ),
      ),
    ).toThrow("no longer current");
    const written = runOpenClawStateWriteTransaction((database) =>
      writePersonalGitLabPublicationInDatabase(
        database,
        second,
        "gateway-second",
        "execution-second",
        { head_commit: "b".repeat(40) },
      ),
    );
    expect(written.head_commit).toBe("b".repeat(40));
  });
});

it("blocks cross-requester and cross-source writes to one unresolved workspace without sharing private receipts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const alice = ensureProfileForEmail("gitlab-shared-alice@example.test").id;
    const bob = ensureProfileForEmail("gitlab-shared-bob@example.test").id;
    const account = {
      issuer,
      accountId: 42,
      login: "managed-bot",
      name: "Managed Bot",
      commitEmail: "managed-bot@example.test",
    };
    const record = createGitLabManagedOAuthRecord({
      profileId: "glp_dddddddddddddddddddddddddddddddd",
      scope: "system",
      agentId: "main",
      account,
      tokens: {
        accessToken: "synthetic-shared-access",
        refreshToken: "synthetic-shared-refresh",
        expiresAtMs: Date.now() + 3600000,
        scopes: ["api", "write_repository"],
      },
    });
    await writeGitLabManagedOAuthRecord(record);
    const personal = await replaceUserGitLabConnection(
      bob,
      issuer,
      undefined,
      {
        ...disconnectedUserGitLabConnection(issuer),
        selection: {
          kind: "connected",
          account: { issuer, accountId: 42, login: "managed-bot" },
          tokens: {
            accessToken: "synthetic-personal-access",
            refreshToken: "synthetic-personal-refresh",
            expiresAtMs: Date.now() + 3600000,
            scopes: ["api"],
          },
        },
      },
      current,
    );
    const publisher: GitLabPublicationPublisher = {
      source: "system-configured",
      profileId: record.profileId,
      recordCreatedAtMs: record.createdAtMs,
    };
    const now = Date.now();
    const sessionId = randomUUID();
    const makeRow = (params: {
      owner: string;
      publisher: GitLabPublicationPublisher;
      generation: string;
      branch: string;
      idempotencyKey?: string;
    }): PersonalGitLabPublicationRow => {
      const requestId = randomUUID();
      const receipt = {
        target: {
          issuer,
          projectId: 12,
          projectPath: "org/repo",
          gitUrl: `${issuer}/org/repo.git`,
          webUrl: `${issuer}/org/repo`,
          baseBranch: "master",
        },
        actor: { accountId: 42, login: "managed-bot" },
        publisher: params.publisher,
        sessionIdentity: {
          sessionId,
          sessionKey: "agent:main:shared-test",
          agentId: "main",
          lifecycleRevision: null,
        },
        sourceId: "shared-worktree",
        worktreeId: "shared-worktree",
        repositoryFingerprint: "shared-fingerprint",
        branch: params.branch,
        sourceHead: "b".repeat(40),
        baseTree: "a".repeat(40),
        workspaceHead: "c".repeat(40),
        repositoryRoot: "/tmp/repo",
        sourceIndexTree: "a".repeat(40),
        createdAtMs: now,
      };
      const row: PersonalGitLabPublicationRow = {
        request_id: requestId,
        owner_profile_id: params.owner,
        issuer,
        connection_generation: params.generation,
        idempotency_key: params.idempotencyKey ?? randomUUID(),
        request_digest: "",
        session_id: sessionId,
        session_key: "agent:main:shared-test",
        agent_id: "main",
        session_lifecycle_revision: null,
        worktree_id: "shared-worktree",
        repository_fingerprint: "shared-fingerprint",
        identity_account_id: 42,
        identity_login: "managed-bot",
        branch: params.branch,
        receipt_json: JSON.stringify(receipt),
        status: "requested",
        gateway_instance_id: null,
        execution_id: null,
        head_commit: null,
        pull_request_url: null,
        error_code: null,
        next_action: null,
        last_effect: null,
        effect_state: null,
        push_observation: null,
        result_json: null,
        created_at_ms: now,
        updated_at_ms: now,
        reported_at_ms: null,
      };
      row.request_digest = personalGitLabRequestDigest(row);
      return row;
    };
    const generation = managedGitLabPublicationGeneration({
      publisher,
      issuer,
      accountId: 42,
      login: "managed-bot",
    });
    const first = makeRow({ owner: alice, publisher, generation, branch: "topic" });
    runOpenClawStateWriteTransaction((database) =>
      insertPersonalGitLabPublicationInDatabase(database, first, current),
    );
    const bobShared = makeRow({
      owner: bob,
      publisher,
      generation,
      branch: "topic",
      idempotencyKey: first.idempotency_key,
    });
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        insertPersonalGitLabPublicationInDatabase(database, bobShared, current),
      ),
    ).toThrow("workspace has an unresolved request");
    const bobPersonal = makeRow({
      owner: bob,
      publisher: { source: "personal" },
      generation: personal.generation,
      branch: "topic",
    });
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        insertPersonalGitLabPublicationInDatabase(database, bobPersonal, current),
      ),
    ).toThrow("workspace has an unresolved request");
    const otherBranch = makeRow({
      owner: bob,
      publisher: { source: "personal" },
      generation: personal.generation,
      branch: "other-topic",
    });
    runOpenClawStateWriteTransaction((database) =>
      insertPersonalGitLabPublicationInDatabase(database, otherBranch, current),
    );
    const sharedAfterPersonal = makeRow({
      owner: alice,
      publisher,
      generation,
      branch: "other-topic",
    });
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        insertPersonalGitLabPublicationInDatabase(database, sharedAfterPersonal, current),
      ),
    ).toThrow("workspace has an unresolved request");
    expect(
      readSharedGitLabPublicationInDatabase(openOpenClawStateDatabase().db, {
        issuer,
        sessionId,
        sessionKey: first.session_key,
        agentId: "main",
        lifecycleRevision: null,
        selector: { requestId: otherBranch.request_id },
      }),
    ).toBeUndefined();
    await insertRegistryWorktree(process.env, {
      id: first.worktree_id,
      name: "topic",
      path: "/tmp/repo",
      repoRoot: "/tmp/repo",
      repoFingerprint: first.repository_fingerprint,
      branch: first.branch,
      baseRef: "origin/master",
      ownerKind: "session",
      ownerId: first.session_key,
      createdAt: now,
      lastActiveAt: now,
    });
    const claimed = runOpenClawStateWriteTransaction((database) =>
      claimPersonalGitLabPublicationInDatabase(database, first, "gateway", "execution", current),
    );
    runOpenClawStateWriteTransaction((database) =>
      writePersonalGitLabPublicationInDatabase(database, claimed, "gateway", "execution", {
        status: "published",
        head_commit: "d".repeat(40),
        pull_request_url: `${issuer}/org/repo/-/merge_requests/9`,
        result_json: JSON.stringify({
          status: "published",
          requestId: first.request_id,
          url: `${issuer}/org/repo/-/merge_requests/9`,
          repository: "org/repo",
          branch: first.branch,
          headCommit: "d".repeat(40),
        }),
      }),
    );
    const readShared = (workspace: { id: string; repoFingerprint: string; branch: string }) =>
      readSharedGitLabPublicationInDatabase(openOpenClawStateDatabase().db, {
        issuer,
        sessionId,
        sessionKey: first.session_key,
        agentId: "main",
        lifecycleRevision: null,
        selector: { latest: true },
        workspace,
      });
    const workspace = {
      id: first.worktree_id,
      repoFingerprint: first.repository_fingerprint,
      branch: first.branch,
    };
    expect(readShared(workspace)?.request_id).toBe(first.request_id);
    expect(readShared({ ...workspace, id: randomUUID() })).toBeUndefined();
    expect(readShared({ ...workspace, repoFingerprint: "another-fingerprint" })).toBeUndefined();
    expect(readShared({ ...workspace, branch: "another-branch" })).toBeUndefined();
    await updateRegistryWorktree(process.env, first.worktree_id, { removedAt: Date.now() });
    expect(readShared(workspace)).toBeUndefined();
    expect(
      readSharedGitLabPublicationInDatabase(openOpenClawStateDatabase().db, {
        issuer,
        sessionId,
        sessionKey: first.session_key,
        agentId: "main",
        lifecycleRevision: null,
        selector: { requestId: first.request_id },
      })?.request_id,
    ).toBe(first.request_id);
  });
});

it("compiles the shared publisher predicate with guarded PostgreSQL JSON parsing and bound values", () => {
  // Compile-only facade: this fixture cannot execute a database request.
  using anchor = new DatabaseSync(":memory:");
  const unavailable = vi.fn((): never => {
    throw new Error("compile-only PostgreSQL fixture");
  });
  const db: PostgresSqlConnection = {
    anchor,
    mutationRevision: 0,
    advisoryLockKey: 0n,
    isOpen: true,
    isTransaction: false,
    prepare: unavailable,
    exec: unavailable,
    close: unavailable,
    query: unavailable,
    runTransaction: unavailable,
  };
  Object.defineProperty(db, Symbol.for("openclaw.postgres-sync-connection"), { value: true });
  const query = getNodeSqliteKysely<{ receipts: { receipt_json: string } }>(db)
    .selectFrom("receipts")
    .select("receipt_json")
    .where(gitLabSharedPublisherPredicate(db))
    .compile();
  expect(query.sql).toContain("CASE WHEN pg_input_is_valid");
  expect(query.sql).toContain("::jsonb #>>");
  expect(query.sql).not.toMatch(/json_valid|json_extract/);
  expect(query.parameters).toEqual(["$.publisher.source", "system-configured", "agent-override"]);
});

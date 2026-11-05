import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { Value } from "typebox/value";
import { afterEach, assert, expect, it, vi } from "vitest";
import { SessionGitHubReadinessResultSchema } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { updateRegistryWorktree } from "../../agents/worktrees/registry.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import * as readCandidates from "../../config/sessions/session-store-read-candidates.js";
import * as targetInventory from "../../config/sessions/session-store-target-inventory.js";
import {
  historyLane,
  projectionLane,
  targetDiscoveryLane,
  rotateDatabaseWorkers,
} from "../../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OpenClawSchema } from "../../config/zod-schema.js";
import * as sqliteBackup from "../../infra/sqlite-backup.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "../../infra/sqlite-private-directory.js";
import { SQLITE_SNAPSHOT_PREFIX } from "../../infra/sqlite-snapshot-retirement.js";
import { inspectDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { holdStateRead } from "../../state/github-publication-fixtures.test-support.js";
import { repositoryRow } from "../../state/github-publication.worker.test-support.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
  readOpenClawAgentDatabaseRegistryToken,
  listOpenClawRegisteredAgentDatabases,
} from "../../state/openclaw-agent-db-registry.js";
import * as agentResources from "../../state/openclaw-agent-db-resources.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  isOpenClawStateDatabaseOpen,
} from "../../state/openclaw-state-db-cache.js";
import { ensureGitHubPublicationSchema } from "../../state/openclaw-state-db-schema-additive.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { digestGitHubPublicationRequest } from "../github-publication-receipt.js";
import {
  claimGitHubPublicationExecutionFixture,
  createGitHubPublicationExecutionStoreFixture,
  insertRepositoryGitHubPublicationFixture,
} from "../github-publication-store.test-support.js";
import { insertGitHubPublicationRequest } from "../github-publication-store.worker.js";
import { repositoryGitHubPublicationDigest } from "../github-repository-publication.kernel.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sessionKey, sessionId, type ReadFixture } from "./sessions-github-read.test-support.js";
import {
  bind,
  fixture,
  git,
  githubOrigin,
  temporary,
  tool,
} from "./sessions-github-readiness.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

afterEach(() => vi.restoreAllMocks());
const unbound = {
  policy: { read: "admitted", write: "unknown" },
  custody: { kind: "unbound_workspace" },
  target: { kind: "unknown", reason: "not-qualified" },
  request: { kind: "none", selection: "current" },
};

async function call(f: ReadFixture, params: Record<string, unknown> = {}, internal = false) {
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "readiness-rpc",
      method: "sessions.github.readiness",
      params: { sessionKey, ...params },
    },
    context: f.context,
    client: internal ? null : f.client,
    isWebchatConnect: () => false,
    respond,
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0]!;
}
async function observe(f: ReadFixture, params: Record<string, unknown> = {}, internal = false) {
  const [ok, value, error] = await call(f, params, internal);
  assert(ok, JSON.stringify(error));
  assert(Value.Check(SessionGitHubReadinessResultSchema, value), JSON.stringify(value));
  return value;
}
async function expectUnknownRequest(f: ReadFixture, requestId: string, reason = "not-observable") {
  expect((await observe(f, { requestId })).request).toEqual({
    kind: "unknown",
    reason,
    selectedRequestId: requestId,
  });
}
const readerSession = { agentId: "main", sessionKey };
async function bindRepository(owner = sessionKey, branch?: string) {
  const workspace = await getSessionRepositoryWorkspaceStore().create({
    agentId: "main",
    sessionKey: owner,
    url: githubOrigin,
    branch,
    assertCurrent() {},
  });
  await upsertSessionEntryCore(readerSession, { repositoryWorkspaceId: workspace.workspaceId });
  return workspace;
}
function publishedFields(branch: string) {
  return {
    url: "https://github.com/example/project/pull/1",
    repository: "example/project",
    branch,
    headCommit: "a".repeat(40),
  };
}
function seed(worktree: Awaited<ReturnType<typeof bind>>, key = sessionKey) {
  ensureGitHubPublicationSchema(openOpenClawStateDatabase().db);
  const requestId = randomUUID();
  const request = { sessionKey: key, agentId: "main", idempotencyKey: requestId, draft: false };
  return runOpenClawStateWriteTransaction(({ db }) =>
    insertGitHubPublicationRequest(db, {
      request,
      requestId,
      requestDigest: digestGitHubPublicationRequest({ ...request, sessionId }),
      sessionId,
      lifecycleRevision: null,
      requester: { version: 1, actor: { kind: "system" }, scopes: ["operator.admin"], grant: null },
      assertCurrent() {},
      now: 1000,
      worktree,
      identity: {
        source: "system-configured",
        profileId: "fixture-profile",
        account: { accountId: 7, login: "fixture-bot", avatarUrl: null },
      },
    }),
  );
}
// Readiness reads through the live owner: stored bytes stay unchanged and no private
// whole-database copy is staged. SQLite's own -wal/-shm on open are not custody changes.
async function databaseArtifacts(
  paths = [resolveOpenClawStateSqlitePath(), resolveOpenClawAgentSqlitePath({ agentId: "main" })],
) {
  const values: Record<string, string> = {};
  for (const pathname of paths) {
    try {
      values[pathname] = createHash("sha256")
        .update(await fs.readFile(pathname))
        .digest("hex");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  const staging = resolvePrivateSqliteSnapshotStagingRoot();
  const copies = (await fs.readdir(staging).catch(() => [] as string[])).filter((name) =>
    name.startsWith(SQLITE_SNAPSHOT_PREFIX),
  );
  return { ...values, snapshotCopies: copies.length };
}
async function cold() {
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
}

it("observes an unbound source through the validated publisher and registered Gateway", async () => {
  await fixture(async (f) => {
    expect((await tool(f, { action: "readiness" })).details).toMatchObject(unbound);
  });
});
it("registers a separate source-qualified read for broad and internal operators", async () => {
  await fixture(async (f) => {
    for (const internal of [false, true]) {
      expect(await observe(f, {}, internal)).toMatchObject(unbound);
    }
  });
});
it.each(["github.com", "github.example.test"])(
  "qualifies real managed Git for %s without cross-host cache reuse or file staging",
  async (host) => {
    await fixture(async (f) => {
      const config = f.context.getRuntimeConfig();
      const selectHost = (selected: string) => {
        const next = {
          ...config,
          gateway: {
            ...config.gateway,
            github: {
              ...config.gateway?.github,
              host: selected,
              apiBaseUrl:
                selected === "github.com" ? "https://api.github.com" : `https://${selected}/api/v3`,
            },
          },
        };
        expect(OpenClawSchema.safeParse(next).success).toBe(true);
        setRuntimeConfigSnapshot(next);
      };
      selectHost(host);
      const worktree = await bind(`https://${host}/example/project.git`);
      await fs.writeFile(path.join(worktree.path, "unpublished.txt"), "preserve me");
      const head = await git(worktree.path, "rev-parse", "HEAD");
      const status = await git(worktree.path, "status", "--porcelain");
      openOpenClawStateDatabase();
      const backups = vi.spyOn(sqliteBackup, "backupNodeSqliteDatabase");
      const repositoryReads = vi.spyOn(managedWorktrees, "resolveRepositoryIdentity");
      const first = await observe(f);
      expect(first).toMatchObject({
        custody: { kind: "qualified", source: "worktree" },
        target: { kind: "supported", basis: "registered-repository", freshness: "observed" },
      });
      expect(repositoryReads).toHaveBeenCalledTimes(1);
      expect((await observe(f)).target).toMatchObject({ freshness: "cached" });
      expect(repositoryReads).toHaveBeenCalledTimes(1);
      selectHost(host === "github.com" ? "github.example.test" : "github.com");
      expect((await observe(f)).target).toEqual({ kind: "unsupported" });
      expect(repositoryReads).toHaveBeenCalledTimes(2);
      selectHost(host);
      expect((await observe(f)).target).toMatchObject({ kind: "supported", freshness: "cached" });
      expect(repositoryReads).toHaveBeenCalledTimes(2);
      expect(backups).not.toHaveBeenCalled();
      expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(head);
      expect(await git(worktree.path, "status", "--porcelain")).toBe(status);
      expect(await fs.readFile(path.join(worktree.path, "unpublished.txt"), "utf8")).toBe(
        "preserve me",
      );
      await updateRegistryWorktree(process.env, worktree.id, { removedAt: 2 });
      expect((await observe(f)).custody).toEqual({ kind: "changed" });
    });
  },
);
it.each(["", "https://example.test/project.git"])(
  "distinguishes an unsupported origin %s from unbound custody",
  async (origin) => {
    await fixture(async (f) => {
      await bind(origin);
      expect(await observe(f)).toMatchObject({
        custody: { kind: "qualified", source: "worktree" },
        target: { kind: "unsupported" },
      });
    });
  },
);
it("reads current pending rows without a second request or settlement", async () => {
  await fixture(async (f) => {
    const worktree = await bind();
    const row = seed(worktree);
    expect((await observe(f)).request).toMatchObject({
      kind: "observed",
      selection: "current",
      receipt: { requestId: row.request_id, status: "requested" },
    });
    const before = await databaseArtifacts();
    const first = await observe(f, { requestId: row.request_id });
    expect(first.request).toMatchObject({
      kind: "observed",
      selection: "exact",
      receipt: { requestId: row.request_id, status: "requested" },
    });
    expect(first.remedies).toContainEqual({ kind: "observe_request", requestId: row.request_id });
    // Reobserving after a lost reply is the same read, not a new publication.
    expect((await observe(f, { requestId: row.request_id })).request).toEqual(first.request);
    expect(await databaseArtifacts()).toEqual(before);
    runOpenClawStateWriteTransaction(({ db }) =>
      db.exec("DELETE FROM github_publication_session_lifecycles"),
    );
    await expectUnknownRequest(f, row.request_id, "unavailable");
  });
});
it("keeps exact terminal history when source is unavailable and excludes foreign receipts", async () => {
  await fixture(async (f) => {
    const worktree = await bind();
    const row = seed(worktree);
    const foreign = seed(worktree, "agent:main:foreign");
    const claimed = claimGitHubPublicationExecutionFixture(row.request_id, "readiness-fixture");
    createGitHubPublicationExecutionStoreFixture("readiness-fixture").complete(claimed, {
      requestId: row.request_id,
      status: "published",
      ...publishedFields(worktree.branch),
    });
    vi.spyOn(managedWorktrees, "resolveRepositoryIdentity").mockRejectedValue(
      new Error("synthetic unavailable repository"),
    );
    expect(await observe(f, { requestId: row.request_id })).toMatchObject({
      custody: { kind: "unknown", reason: "unavailable" },
      request: {
        kind: "observed",
        selection: "exact",
        receipt: { requestId: row.request_id, status: "published" },
      },
    });
    await expectUnknownRequest(f, foreign.request_id);
  });
});
it("observes repository-only shared receipts while personal receipts remain private", async () => {
  await fixture(
    async (f) => {
      const workspace = await bindRepository(sessionKey, "feature");
      const requestId = randomUUID();
      const row = {
        ...repositoryRow(requestId),
        session_id: sessionId,
        session_key: sessionKey,
        workspace_id: workspace.workspaceId,
        branch: workspace.branch,
        last_effect: "push",
        effect_state: "dispatched",
      };
      row.request_digest = repositoryGitHubPublicationDigest(row);
      insertRepositoryGitHubPublicationFixture(row, () => {});
      const personal = {
        ...row,
        request_id: randomUUID(),
        idempotency_key: randomUUID(),
        identity_source: "personal",
        owner_profile_id: "private-person",
        connection_generation: randomUUID(),
      };
      personal.request_digest = repositoryGitHubPublicationDigest(personal);
      insertRepositoryGitHubPublicationFixture(personal, () => {});
      const backups = vi.spyOn(sqliteBackup, "backupNodeSqliteDatabase");
      expect(await observe(f)).toMatchObject({
        custody: { kind: "qualified", source: "repository" },
        target: { kind: "supported", basis: "repository-url" },
        request: {
          kind: "observed",
          receipt: { requestId, effect: { kind: "push", status: "dispatched" } },
        },
      });
      expect((await observe(f, { requestId })).remedies).toContainEqual({
        kind: "observe_request",
        requestId,
      });
      await expectUnknownRequest(f, personal.request_id);
      expect(backups).not.toHaveBeenCalled();
    },
    { personal: true },
  );
});
it.each([false, true])(
  "preserves cold DB and sidecar names and bytes through full authority (profile=%s)",
  async (personal) => {
    await fixture(
      async (f) => {
        await bindRepository();
        await cold();
        const before = await databaseArtifacts();
        expect((await observe(f)).custody).toEqual({ kind: "qualified", source: "repository" });
        expect(await databaseArtifacts()).toEqual(before);
      },
      { personal },
    );
  },
);
it("keeps an absent shared database absent and does not manufacture an exact receipt", async () => {
  await fixture(async (f) => {
    await cold();
    const shared = resolveOpenClawStateSqlitePath();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      await fs.rm(shared + suffix, { force: true });
    }
    const before = await databaseArtifacts();
    const requestId = randomUUID();
    await expectUnknownRequest(f, requestId);
    expect(await databaseArtifacts()).toEqual(before);
  });
});
it.each([
  "connection",
  "profile",
  "grant",
  "session",
  "visibility",
  "source",
  "registry-remove",
  "published-replacement",
  "registry-same",
  "session-metadata",
] as const)("checks post-await %s custody before observation", async (kind) => {
  await fixture(
    async (f) => {
      const grant = new AbortController();
      f.client.internal = {
        operatorAccessAuthority: {
          signal: grant.signal,
          assertCurrent: () => grant.signal.throwIfAborted(),
        },
      };
      // Start cold so the held read reacquires the agent source. The live profile
      // catalog keeps its existing shared-store admission for method-policy checks.
      await closeOpenClawAgentDatabasesAsync();
      const original = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const replacement = original + ".replacement";
      if (kind === "published-replacement") {
        await fs.copyFile(original, replacement);
      }
      const sourceWitness = vi.spyOn(
        agentResources,
        "registerOpenClawAgentDatabaseReadCandidateResource",
      );
      const registryToken = readOpenClawAgentDatabaseRegistryToken({ env: process.env });
      const physicalSource = inspectDatabasePathIdentitySync(original);
      const held = holdStateRead("githubPublications.sharedObservation");
      const pending = call(f);
      try {
        await awaitGateBeforeSettlement(
          held.ready,
          pending,
          "readiness returned before real receipt read",
        );
        if (kind === "connection") {
          f.disconnect();
        } else if (kind === "profile") {
          f.client.authenticatedUserProfile = undefined;
        } else if (kind === "grant") {
          grant.abort();
        } else if (kind === "source") {
          await closeOpenClawAgentDatabasesAsync();
        } else if (
          kind === "registry-remove" ||
          kind === "published-replacement" ||
          kind === "registry-same"
        ) {
          expect(sourceWitness.mock.calls.some(([source]) => source.path === original)).toBe(true);
          if (kind === "registry-same") {
            registerOpenClawAgentDatabase({ agentId: "main", path: original });
          } else if (kind === "registry-remove") {
            unregisterOpenClawAgentDatabase({ agentId: "main", path: original });
          } else {
            await fs.rename(original, original + ".retired");
            await fs.rename(replacement, original);
            registerOpenClawAgentDatabase({ agentId: "main", path: original });
          }
        } else if (kind === "session-metadata") {
          await upsertSessionEntryCore(readerSession, { label: "Changed title" });
        } else if (kind === "visibility") {
          await upsertSessionEntryCore(readerSession, { visibility: "draft" });
        } else {
          await upsertSessionEntryCore(readerSession, { lifecycleRevision: randomUUID() });
        }
        held.release();
        const [ok, payload, error] = await pending;
        expect((await databaseArtifacts([])).snapshotCopies, "no agent snapshot copies").toBe(0);
        if (kind.startsWith("registry-") || kind === "published-replacement") {
          const registered = listOpenClawRegisteredAgentDatabases({ env: process.env }).some(
            (row) => row.agentId === "main" && row.path === original,
          );
          const physicalUnchanged =
            inspectDatabasePathIdentitySync(original)?.key === physicalSource?.key;
          const registryAdvanced =
            readOpenClawAgentDatabaseRegistryToken({ env: process.env }) !== registryToken;
          expect(registryAdvanced).toBe(true);
          expect(registered).toBe(kind !== "registry-remove");
          expect(physicalUnchanged).toBe(kind !== "published-replacement");
        }
        if (kind === "registry-same" || kind === "session-metadata") {
          expect(ok).toBe(true);
          expect(payload).toMatchObject(unbound);
          expect(error).toBeUndefined();
        } else {
          expect(ok).toBe(false);
          expect(payload).toBeUndefined();
          expect(error).toBeDefined();
        }
      } finally {
        held.release();
        await pending;
        held.restore();
        sourceWitness.mockRestore();
      }
    },
    {
      personal: true,
      scopes: ["operator.sessions.read"],
      others: "view",
      foreign: kind === "visibility",
    },
  );
});
it("rejects incompatible fields and pending authentication without starting refresh", async () => {
  await fixture(async (f) => {
    for (const params of [
      { workspacePath: "/never-adopt" },
      { idempotencyKey: "never-allocate" },
      { selection: { source: "personal" } },
    ]) {
      expect((await call(f, params))[0]).toBe(false);
    }
    await expect(tool(f, { action: "readiness", title: "never publish" })).rejects.toThrow(
      "readiness accepts only",
    );
    const sync = vi.fn(async () => {
      throw new Error("Observation must not refresh login");
    });
    f.client.authenticatedGitHubIdentitySync = sync;
    f.client.authenticatedUserProfile = undefined;
    expect((await call(f))[0]).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });
});

it("distinguishes prepared imports, incomplete imports, archived and missing custody", async () => {
  await fixture(async (f) => {
    const worktree = await bind();
    const head = await git(worktree.path, "rev-parse", "HEAD");
    const binding = {
      url: "https://github.com/example/project/pull/7",
      host: "github.com",
      number: 7,
      base: { repository: "example/project", repositoryId: 1, branch: "main", commit: head },
      head: { repository: "example/project", repositoryId: 1, branch: "feature", commit: head },
    };
    const selected = { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot };
    const imported = { ...selected, githubPullRequest: binding };
    await upsertSessionEntryCore(readerSession, { worktree: imported });
    expect((await observe(f)).custody).toEqual({ kind: "changed" });
    await upsertSessionEntryCore(readerSession, {
      worktree: { ...selected, githubPullRequest: { ...binding, preparedHeadCommit: head } },
    });
    expect(await observe(f)).toMatchObject({
      custody: { kind: "qualified", source: "imported-pr" },
      target: { kind: "supported", basis: "prepared-imported-pr", freshness: "observed" },
    });
    await upsertSessionEntryCore(readerSession, { archivedAt: 100 });
    expect((await observe(f)).custody).toEqual({ kind: "archived" });
    await upsertSessionEntryCore(readerSession, {
      archivedAt: undefined,
      worktree: { ...selected, id: randomUUID() },
    });
    expect((await observe(f)).custody).toEqual({ kind: "changed" });
  });
});

it("keeps wrong repository ownership distinct from a genuinely unbound workspace", async () => {
  await fixture(async (f) => {
    await bindRepository("agent:main:another-owner");
    expect((await observe(f)).custody).toEqual({ kind: "changed" });
  });
});

it("selects only a child publication session through the actual tool", async () => {
  await fixture(async (f) => {
    const child = "agent:main:readiness-child";
    const unrelated = "agent:main:readiness-unrelated";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: child },
      {
        sessionId: randomUUID(),
        updatedAt: 1,
        parentSessionKey: sessionKey,
      },
    );
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: unrelated },
      { sessionId: randomUUID(), updatedAt: 1 },
    );
    await cold();
    const before = await databaseArtifacts();
    expect(
      (await tool(f, { action: "readiness", publishingSessionKey: child })).details,
    ).toMatchObject(unbound);
    await expect(tool(f, { action: "readiness", publishingSessionKey: unrelated })).rejects.toThrow(
      /not a child/,
    );
    expect(await databaseArtifacts()).toEqual(before);
  });
});

it("keeps native read denial ahead of source or receipt observation", async () => {
  await fixture(
    async (f) => {
      const receiptRead = vi.spyOn(f.context.githubPublicationService!, "latestShared");
      expect((await call(f))[0]).toBe(false);
      expect(receiptRead).not.toHaveBeenCalled();
    },
    { personal: true, scopes: [] },
  );
});

it.each([
  ["custom.json", false],
  ["shared.sqlite", false],
  ["shared.sqlite", true],
] as const)(
  "preserves cold configured locator %s without registry ownership (roleReader=%s)",
  async (name, roleReader) => {
    await fixture(
      async (f) => {
        const root = await fs.realpath(temporary.make("readiness-locator-"));
        const storePath = path.join(root, name);
        const databasePath = path.join(root, name.replace(/\.json$/, ".sqlite"));
        const config = f.context.getRuntimeConfig();
        const readConfig = {
          ...config,
          session: { ...config.session, store: storePath },
        };
        OpenClawSchema.parse(readConfig);
        setRuntimeConfigSnapshot(readConfig);
        expect(operatorSessionCap(f.client, f.context.getRuntimeConfig())).toBe(
          roleReader ? "view" : undefined,
        );
        const creator = roleReader
          ? ensureProfileForEmail("other-publication-reader@example.test")
          : undefined;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey, storePath },
          {
            sessionId,
            updatedAt: 1,
            ...(creator
              ? {
                  visibility: "read-only",
                  createdActor: { type: "human", source: "profile", id: creator.id },
                }
              : {}),
          },
        );
        if (roleReader) {
          await addSessionMember(
            { agentId: "main", sessionKey, storePath },
            { identityId: f.client.authenticatedUserProfile!.profileId, addedBy: creator!.id },
          );
        }
        // A registered control proves the configured source reaches the real read surface.
        expect(await observe(f)).toMatchObject(unbound);
        await closeOpenClawAgentDatabasesAsync();
        // Cold database custody is not a whole-Gateway shutdown. Exact close drains
        // shared handles/snapshots while preserving the already-booted reader pool.
        if (!roleReader) {
          await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath());
          expect(isOpenClawStateDatabaseOpen(resolveOpenClawStateSqlitePath())).toBe(false);
        }
        unregisterOpenClawAgentDatabase({ agentId: "main", path: databasePath });
        await closeOpenClawAgentDatabasesAsync();
        // Agent close releases database handles but may retain qualified idle Workers.
        // Rotate the read lanes too: instrumentation must precede their next real imports.
        for (const lane of [historyLane, projectionLane, targetDiscoveryLane]) {
          await rotateDatabaseWorkers(lane);
          expect(lane.native).toBe(false);
          expect(lane.pending).toBe(0);
        }
        // The role-based profile catalog stays live; its shared-memory lock bytes are not a cold source.
        const sourcePaths = roleReader
          ? [databasePath]
          : [
              resolveOpenClawStateSqlitePath(),
              resolveOpenClawAgentSqlitePath({ agentId: "main" }),
              databasePath,
            ];
        expect(
          listOpenClawRegisteredAgentDatabases({ env: process.env }).some(
            (row) => row.path === databasePath,
          ),
        ).toBe(false);
        const before = await databaseArtifacts(sourcePaths);
        expect(before).toHaveProperty(databasePath);
        expect(fsSync.existsSync(databasePath + "-wal")).toBe(false);
        expect(fsSync.existsSync(databasePath + "-shm")).toBe(false);
        const counts = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4));
        const create = workerCpu.createCpuTrackedWorker;
        const observer = vi
          .spyOn(workerCpu, "createCpuTrackedWorker")
          .mockImplementation((filename, options) => {
            if (options?.eval) {
              return create(filename, options);
            }
            const entry = typeof filename === "string" ? pathToFileURL(filename) : filename;
            const key = "openclaw.test.readinessNativeReads";
            const previous = getEnvironmentData(key);
            setEnvironmentData(key, {
              entry: entry.href,
              source: databasePath,
              counts: counts.buffer,
            });
            try {
              return create(
                new URL("./sessions-github-readiness.native.test-support.mjs", import.meta.url),
                options,
              );
            } finally {
              setEnvironmentData(key, previous);
            }
          });
        // Path qualification stays in discovery workers. Live reads still take the
        // per-read admission identity check every Gateway session read performs.
        const hostQualification = [
          vi.spyOn(targetInventory, "prepareSessionStoreTargetInventory"),
          vi.spyOn(targetInventory, "captureSessionStoreReadCandidates"),
          vi.spyOn(readCandidates, "captureSessionStoreReadCandidate"),
        ];
        try {
          expect(await observe(f)).toMatchObject(unbound);
          expect(await observe(f)).toMatchObject(unbound);
          expect(await databaseArtifacts(sourcePaths)).toEqual(before);
          expect(
            hostQualification.map((spy) => spy.mock.calls.length),
            "Gateway thread must not qualify session-store paths",
          ).toEqual([0, 0, 0]);
          const nativeReadCounts = Array.from(counts);
          if (roleReader) {
            const member = f.client.authenticatedUserProfile!.profileId;
            const scope = { agentId: "main", sessionKey, storePath };
            // Prepare the existing writer after cold/warm measurements; preserve membership.
            expect(
              (await addSessionMember(scope, { identityId: member, addedBy: creator!.id }))
                .inserted,
            ).toBe(false);
            for (const changed of ["member", "role", "scope"] as const) {
              const held = holdStateRead("githubPublications.sharedObservation");
              const pending = call(f);
              try {
                await awaitGateBeforeSettlement(
                  held.ready,
                  pending,
                  "Role-based read returned before held observation",
                );
                if (changed === "member") {
                  const removed = await removeSessionMember(scope, member);
                  expect(removed?.identityId).toBe(member);
                } else {
                  const current = f.context.getRuntimeConfig();
                  const roleConfig: OpenClawConfig = {
                    ...current,
                    gateway: {
                      ...current.gateway,
                      roles: {
                        ...current.gateway?.roles,
                        definitions: {
                          ...current.gateway?.roles?.definitions,
                          guest: {
                            scopes: changed === "scope" ? [] : ["operator.sessions.read"],
                            agents: ["main"],
                            sessions: { others: changed === "role" ? "none" : "view" },
                          },
                        },
                      },
                    },
                  };
                  OpenClawSchema.parse(roleConfig);
                  setRuntimeConfigSnapshot(roleConfig);
                  expect(operatorSessionCap(f.client, f.context.getRuntimeConfig())).toBe(
                    changed === "role" ? "none" : "view",
                  );
                }
                held.release();
                const [ok, payload, error] = await pending;
                if (changed === "member") {
                  // View grants non-draft reads independently of explicit membership.
                  expect(ok).toBe(true);
                  expect(payload).toMatchObject(unbound);
                  expect(error).toBeUndefined();
                } else {
                  expect(ok).toBe(false);
                  expect(payload).toBeUndefined();
                  expect(error?.code).toBe("FORBIDDEN");
                }
              } finally {
                held.release();
                await pending;
                held.restore();
              }
              setRuntimeConfigSnapshot(readConfig);
              expect(operatorSessionCap(f.client, f.context.getRuntimeConfig())).toBe("view");
            }
          }
          expect(nativeReadCounts[0], "real worker SQLite opens must be observed").toBeGreaterThan(
            0,
          );
          // A private image of a live multi-GB agent database stalls the whole Gateway.
          expect(
            nativeReadCounts[1],
            "readiness must read the source through its owner, not a private image",
          ).toBeGreaterThan(0);
          expect(
            nativeReadCounts[2],
            "worker must inspect original source identity",
          ).toBeGreaterThan(0);
          expect(
            nativeReadCounts[3],
            "worker must resolve original source identity",
          ).toBeGreaterThan(0);
        } finally {
          for (const spy of hostQualification) {
            spy.mockRestore();
          }
          observer.mockRestore();
        }
      },
      roleReader
        ? { personal: true, scopes: ["operator.sessions.read"], others: "view", foreign: true }
        : {},
    );
  },
);

it.each(["requested", "publishing", "published", "failed"] as const)(
  "projects only readiness facts from a real %s receipt",
  async (status) => {
    await fixture(async (f) => {
      const worktree = await bind();
      const row = seed(worktree);
      const published = publishedFields(worktree.branch);
      const details =
        status === "published" ? published : status === "failed" ? { code: "unavailable" } : {};
      if (status !== "requested") {
        const claim = claimGitHubPublicationExecutionFixture(row.request_id, "projection-fixture");
        const store = createGitHubPublicationExecutionStoreFixture("projection-fixture");
        if (status === "published") {
          const tree = "b".repeat(40);
          const captured = store.bindWorkspaceSnapshot({
            row: claim,
            sourceHeadCommit: published.headCommit,
            sourceIndexTree: tree,
            workspaceTree: tree,
          });
          store.complete(captured, { requestId: row.request_id, status, ...published });
        } else if (status === "failed") {
          store.complete(claim, {
            requestId: row.request_id,
            status,
            code: "unavailable",
            message: "Private failure detail",
            nextAction: "Private recovery action",
          });
        }
      }
      const params = { requestId: row.request_id };
      const legacyReceipt = { requestId: row.request_id, status, ...details };
      expect((await observe(f, params)).request).toEqual({
        kind: "observed",
        selection: "exact",
        receipt: legacyReceipt,
      });
      if (status === "published") {
        const current = { ...legacyReceipt, unchanged: true };
        expect((await tool(f, { action: "readiness", ...params })).details).toMatchObject({
          request: { receipt: current },
        });
        assert(f.client.connect);
        f.client.connect.caps = ["github-publication-unchanged"];
        expect((await observe(f, params)).request).toMatchObject({ receipt: current });
      }
    });
  },
);

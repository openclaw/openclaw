import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  deleteRegistryWorktree,
  insertRegistryWorktree,
  updateRegistryWorktree,
} from "../agents/worktrees/registry.js";
import { findLiveRegistryWorktreeByOwner } from "../agents/worktrees/registry.test-support.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import * as configIo from "../config/io.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "../config/sessions/session-actor-storage-result.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  hasSupportedGitHubPublicationTarget,
  prepareGitHubPublicationWorkspaceOwner,
} from "./github-publication-availability.js";
import {
  readGitHubPublicationFact,
  startGitHubPublicationDiscovery,
} from "./github-publication-discovery.js";
import { prepareGitHubPublicationFact } from "./worker-environments/worker-github-binding.js";

async function prepareGitHubPublicationAvailability(
  params: Parameters<typeof prepareGitHubPublicationFact>[0],
) {
  return (await prepareGitHubPublicationFact(params))?.available ?? false;
}

const identity = {
  source: "system-detected",
  account: { login: "test" },
  env: { GH_TOKEN: "synthetic" },
};
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  sessionRead: vi.fn(),
  admittedSessionRead: vi.fn(),
  config: vi.fn(),
  identity: vi.fn(),
}));
// mock-isolation: Keep session-owner SQL outside the worktree-read measurement.
vi.mock("./session-utils.js", () => ({
  loadIncognitoGatewaySessionEntryReadOnly: (...args: unknown[]) => mocks.session(...args),
}));
// mock-isolation: Keep session-worker state outside the worktree-read measurement.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<
      typeof import("./session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >[0],
  ) => {
    const loaded = await mocks.sessionRead(params);
    params.onSelected?.({
      ...loaded,
      storePath: "/synthetic/admitted.sqlite",
      storeKeys: [loaded.canonicalKey],
      store: { [loaded.canonicalKey]: loaded.entry },
      capturedReadSource: {
        agentId: loaded.agentId,
        path: "/synthetic/admitted.sqlite",
        databaseIdentity: "publication-worker-fixture",
      },
    });
    return loaded;
  },
}));
// mock-isolation: Supply fresh row facts from the admitted physical session reader.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: async <T>(
    scope: Parameters<
      typeof import("../config/sessions/session-entry-read-runtime.js").withSessionEntryReadOnlyInWorker
    >[0],
    assertCurrent: () => void,
    consume: Parameters<
      typeof import("../config/sessions/session-entry-read-runtime.js").withSessionEntryReadOnlyInWorker<T>
    >[2],
  ) => {
    const loaded = await mocks.admittedSessionRead(scope, assertCurrent);
    return await consume(
      {
        ok: true,
        value: loaded.entries.find(
          (row: { sessionKey: string }) => row.sessionKey === scope.sessionKey,
        )?.entry,
      },
      {
        kind: "file",
        assertCurrent,
        source: {
          agentId: scope.agentId ?? "main",
          path: scope.storePath ?? "/synthetic/admitted.sqlite",
          databaseIdentity: "publication-worker-fixture",
        },
      },
    );
  },
}));
vi.mock("../config/sessions/session-entry-read-facts.js", async (original) => {
  const actual = await original<typeof import("../config/sessions/session-entry-read-facts.js")>();
  return {
    ...actual,
    readRetainedSessionEntryFacts: ((database, request, owner) => {
      if (
        database.agentId !== session.agentId ||
        database.path !== sessionStorePath ||
        !request.sessionKeys?.includes(session.sessionKey)
      ) {
        return actual.readRetainedSessionEntryFacts(database, request, owner);
      }
      return {
        kind: "session-exact-entries",
        source: sessionReadSource,
        databaseIdentity: {
          identity: sessionReadSource.databaseIdentity,
          incarnation: "synthetic",
          filename: sessionStorePath,
          canonicalPath: sessionStorePath,
        },
        entries: [{ sessionKey: session.sessionKey, entry: mocks.session().entry }],
        lifecycleTimestamps: {},
      };
    }) satisfies typeof actual.readRetainedSessionEntryFacts,
  };
});
// mock-isolation: Use the synthetic registry without starting managed-worktree services.
vi.mock("../agents/worktrees/service.js", () => ({
  managedWorktrees: {
    resolveRepositoryIdentity: async () => ({
      checkoutRoot: worktree.path,
      repoRoot: worktree.repoRoot,
      fingerprint: worktree.repoFingerprint,
      originUrl: "https://github.com/example/publication.git",
    }),
    findLiveByOwner: async (kind: ManagedWorktreeRecord["ownerKind"], id: string) =>
      findLiveRegistryWorktreeByOwner(process.env, kind, id),
  },
}));
// mock-isolation: Control identity preparation without credential discovery.
vi.mock("../agents/github-tool-identity.js", () => ({
  prepareGitHubPublicationIdentity: mocks.identity,
  prepareGitHubPublicationOptionsIdentity: mocks.identity,
  matchesPreparedGitHubPublicationIdentity: () => true,
  resolveConfiguredGitHubToolIdentity: () => undefined,
}));
// mock-isolation: Exclude OAuth credentials and network activity from this reader fixture.
vi.mock("./github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: async () => {},
}));
// mock-isolation: Use synthetic configuration without loading operator configuration.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: mocks.config }));
// mock-isolation: Exclude process-wide secret materialization from this reader fixture.
vi.mock("../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: () => undefined,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionStorePath = "/publication-availability/sessions.sqlite";
const session = { sessionKey: "agent:main:publication", sessionId: "session", agentId: "main" };
const sessionReadSource = {
  agentId: session.agentId,
  path: sessionStorePath,
  databaseIdentity: "synthetic-publication-availability",
};
const worktree: ManagedWorktreeRecord = {
  id: "publication-worktree",
  name: "publication",
  path: "/synthetic/publication",
  repoRoot: "/synthetic/repo",
  repoFingerprint: "synthetic-fingerprint",
  branch: "openclaw/publication",
  baseRef: "main",
  ownerKind: "session",
  ownerId: session.sessionKey,
  createdAt: 1,
  lastActiveAt: 1,
};

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("publication-worktree-read-"));
  mocks.config.mockReset().mockReturnValue({});
  vi.spyOn(configIo, "getRuntimeConfig").mockImplementation(mocks.config);
  mocks.session.mockReset().mockReturnValue({
    canonicalKey: session.sessionKey,
    agentId: session.agentId,
    storePath: sessionStorePath,
    readSource: sessionReadSource,
    entry: {
      sessionId: session.sessionId,
      lifecycleRevision: "lifecycle",
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
    },
  });
  mocks.sessionRead.mockReset().mockImplementation(async () => mocks.session());
  mocks.admittedSessionRead.mockReset().mockImplementation(async () => ({
    entries: [{ sessionKey: session.sessionKey, entry: mocks.session().entry }],
  }));
  mocks.identity.mockReset().mockResolvedValue(identity);
  await insertRegistryWorktree(process.env, worktree);
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "prepares publication availability without caller-thread worktree SQL (present: %s)",
  async (present) => {
    if (!present) {
      await updateRegistryWorktree(process.env, worktree.id, { removedAt: 2 });
    }
    const sql = observeMainThreadSql();
    sql.calibrate();
    expect(await prepareGitHubPublicationAvailability(session)).toBe(present);
    sql.expectIdle();
  },
);

it("rejects an unbound session without dispatching a worktree read", async () => {
  const worker = await import("../state/openclaw-state-worker-store.js");
  const execute = vi.spyOn(worker, "executeOpenClawStateWorker");
  mocks.session.mockReturnValue({
    canonicalKey: session.sessionKey,
    agentId: session.agentId,
    storePath: sessionStorePath,
    readSource: sessionReadSource,
    entry: { sessionId: session.sessionId, lifecycleRevision: "lifecycle" },
  });
  expect(await prepareGitHubPublicationAvailability(session)).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});

it.each(["unbound", "replaced-session", "replaced-lifecycle", "replaced-writer"])(
  "uses the admitted store's current %s row instead of rediscovering another store",
  async (kind) => {
    const entry = { ...mocks.session().entry, activeWriterRunId: "writer" };
    if (kind === "unbound") {
      delete entry.worktree;
    } else if (kind === "replaced-session") {
      entry.sessionId = "replacement";
    } else if (kind === "replaced-lifecycle") {
      entry.lifecycleRevision = "replacement";
    } else {
      entry.activeWriterRunId = "replacement";
    }
    mocks.admittedSessionRead.mockResolvedValue({
      entries: [{ sessionKey: session.sessionKey, entry }],
    });
    await expect(
      prepareGitHubPublicationWorkspaceOwner(session, {
        sessionTarget: {
          ...session,
          storePath: "/synthetic/admitted.sqlite",
          expectedLifecycleRevision: "lifecycle",
          expectedWriterRunId: "writer",
        },
      }),
    ).rejects.toThrow();
    expect(mocks.sessionRead).not.toHaveBeenCalled();
    expect(mocks.admittedSessionRead).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        storePath: "/synthetic/admitted.sqlite",
        projection: [],
      }),
      expect.any(Function),
    );
  },
);

it("rejects a worktree retired while publication identity is prepared", async () => {
  mocks.identity.mockImplementationOnce(async () => {
    await updateRegistryWorktree(process.env, worktree.id, { removedAt: 2 });
    return identity;
  });
  expect(await prepareGitHubPublicationAvailability(session)).toBe(false);
});

it("keeps an admitted stored main alias under its canonical publication owner", async () => {
  mocks.config.mockReturnValue({ session: { scope: "global" } });
  const aliasWorktree = {
    ...worktree,
    id: "publication-global-worktree",
    path: "/synthetic/global-publication",
    branch: "openclaw/global-publication",
    ownerId: "global",
  };
  await insertRegistryWorktree(process.env, aliasWorktree);
  mocks.session.mockReturnValue({
    ...mocks.session(),
    canonicalKey: "global",
    entry: {
      ...mocks.session().entry,
      worktree: {
        id: aliasWorktree.id,
        branch: aliasWorktree.branch,
        repoRoot: aliasWorktree.repoRoot,
      },
    },
  });
  const storedKey = "agent:main:main";
  mocks.admittedSessionRead.mockResolvedValue({
    entries: [{ sessionKey: storedKey, entry: mocks.session().entry }],
  });
  const prepared = await prepareGitHubPublicationWorkspaceOwner(
    { ...session, sessionKey: "global" },
    {
      sessionTarget: {
        ...session,
        sessionKey: storedKey,
        storePath: "/synthetic/admitted.sqlite",
      },
    },
  );
  using _ = { [Symbol.dispose]: () => prepared.release() };
  expect(prepared.initial.loaded.canonicalKey).toBe("global");
  expect(mocks.sessionRead).not.toHaveBeenCalled();
});

it.each(["session", "identity"] as const)(
  "keeps availability reads on the captured physical store across %s preparation",
  async (preparation) => {
    const retarget = () =>
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("publication-other-store-"));
    if (preparation === "session") {
      mocks.sessionRead.mockImplementationOnce(async () => {
        retarget();
        return mocks.session();
      });
    } else {
      mocks.identity.mockImplementationOnce(async () => {
        retarget();
        return identity;
      });
    }
    expect(await prepareGitHubPublicationAvailability(session)).toBe(true);
  },
);

it("keeps target discovery on the captured physical store across session preparation", async () => {
  mocks.sessionRead.mockImplementationOnce(async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("publication-other-store-"));
    return mocks.session();
  });
  expect(await hasSupportedGitHubPublicationTarget(session, () => {})).toBe(true);
});

it.each(["branch replacement", "turn cancellation and release"])(
  "qualifies memory-only private worktrees without host session SQL across %s",
  async (change) => {
    const authority = { assertCurrent() {}, authorize() {} };
    const selected = {
      ...session,
      sessionKey: "agent:main:dashboard:incognito-publication-availability",
    };
    const location = {
      agentId: selected.agentId,
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: selected.agentId }),
    };
    const owner = memorySessionActorOwners.get(location);
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey: selected.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    readSessionActorStorageResult(
      await actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: { entry: { ...mocks.session().entry, updatedAt: Date.now() } },
        },
        authority,
      ),
    );
    await deleteRegistryWorktree(process.env, worktree.id);
    await insertRegistryWorktree(process.env, { ...worktree, ownerId: selected.sessionKey });
    mocks.session.mockImplementation(() => {
      throw new Error("Private authority must not read host session SQL");
    });
    const sql = observeMainThreadSql();
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const discovery = startGitHubPublicationDiscovery({ scheduler });
    try {
      expect(await prepareGitHubPublicationAvailability(selected)).toBe(true);
      if (change === "turn cancellation and release") {
        const turn = new AbortController();
        runWithSessionActorStorage(
          {
            ...location,
            actor,
            authority: {
              assertCurrent: () => turn.signal.throwIfAborted(),
              authorize() {},
            },
          },
          () => readGitHubPublicationFact(selected),
        );
        turn.abort();
        await actor.release();
        await clock.wake();
        expect(readGitHubPublicationFact(selected).available).toBe(true);
      } else {
        mocks.identity.mockImplementationOnce(async () => {
          await patchSessionEntryCore(
            {
              agentId: "main",
              sessionKey: selected.sessionKey,
              storePath: location.path,
            },
            () => ({
              worktree: { id: worktree.id, repoRoot: worktree.repoRoot, branch: "replacement" },
            }),
          );
          return identity;
        });
        expect(await prepareGitHubPublicationAvailability(selected)).toBe(false);
      }
      sql.expectIdle();
    } finally {
      sql.restore();
      await discovery.stop();
      await scheduler.stop();
      await actor.release();
      memorySessionActorOwners.closeDatabase(location);
    }
  },
);

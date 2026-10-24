import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as registryRead from "../agents/worktrees/registry-read.js";
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
import type { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  hasSupportedGitHubPublicationTarget,
  prepareGitHubPublicationSession,
  prepareGitHubPublicationWorkspaceOwner,
} from "./github-publication-availability.js";
import {
  readGitHubPublicationFact,
  startGitHubPublicationDiscovery,
} from "./github-publication-discovery.js";
import type { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
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
// mock-isolation: Exclude session SQL, credentials, and config from worktree-read measurement.
vi.mock("./session-utils.js", () => ({
  loadIncognitoGatewaySessionEntryReadOnly: (...args: unknown[]) => mocks.session(...args),
}));
// mock-isolation: Keep session-worker state outside the worktree-read measurement.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<typeof loadGatewaySessionEntryReadOnlyInWorker>[0],
  ) => {
    const loaded = await mocks.sessionRead(params);
    params.onSelected?.({
      ...loaded,
      storePath: admittedSource.path,
      storeKeys: [loaded.canonicalKey],
      store: { [loaded.canonicalKey]: loaded.entry },
      capturedReadSource: { ...admittedSource, agentId: loaded.agentId },
    });
    return loaded;
  },
}));
// mock-isolation: Supply fresh row facts from the admitted physical session reader.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: async <T>(
    scope: Parameters<typeof withSessionEntryReadOnlyInWorker>[0],
    assertCurrent: () => void,
    consume: Parameters<typeof withSessionEntryReadOnlyInWorker<T>>[2],
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
          ...admittedSource,
          agentId: scope.agentId ?? admittedSource.agentId,
          path: scope.storePath ?? admittedSource.path,
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
// mock-isolation: Keep registry reads real without starting managed-worktree services.
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
  onManagedGitHubProfileChanged: () => () => {},
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
const admittedSource = {
  agentId: session.agentId,
  path: "/synthetic/admitted.sqlite",
  databaseIdentity: "publication-worker-fixture",
};
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
const worktreeEntry = (record = worktree) => ({
  id: record.id,
  branch: record.branch,
  repoRoot: record.repoRoot,
});
const admittedTarget = (sessionKey = session.sessionKey) => ({
  ...session,
  sessionKey,
  storePath: admittedSource.path,
});
const baseEntry = { sessionId: session.sessionId, lifecycleRevision: "lifecycle" };
const setWorktree = (entry: ReturnType<typeof worktreeEntry> | undefined) =>
  mocks.session.mockReturnValue({ ...mocks.session(), entry: { ...baseEntry, worktree: entry } });
const retargetStore = () =>
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("publication-other-store-"));
const rejectHostRead = () => {
  throw new Error("Private authority must not read host session SQL");
};

async function memoryFixture(sessionKey: string, activeWriterRunId?: string) {
  const selected = { ...session, sessionKey };
  const authority = { assertCurrent() {}, authorize() {} };
  const location = {
    agentId: selected.agentId,
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: selected.agentId }),
  };
  const owner = memorySessionActorOwners.get(location);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const entry = {
    ...mocks.session().entry,
    ...(activeWriterRunId ? { activeWriterRunId } : {}),
    updatedAt: Date.now(),
  };
  readSessionActorStorageResult(
    await actor.storage!.mutate({ type: "session.entry.create", input: { entry } }, authority),
  );
  await deleteRegistryWorktree(process.env, worktree.id);
  await insertRegistryWorktree(process.env, { ...worktree, ownerId: sessionKey });
  return {
    selected,
    location,
    actor,
    binding: { ...location, actor, authority },
    async [Symbol.asyncDispose]() {
      await actor.release();
      memorySessionActorOwners.closeDatabase(location);
    },
  };
}

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("publication-worktree-read-"));
  mocks.config.mockReset().mockReturnValue({});
  vi.spyOn(configIo, "getRuntimeConfig").mockImplementation(mocks.config);
  mocks.session.mockReset().mockReturnValue({
    canonicalKey: session.sessionKey,
    agentId: session.agentId,
    storePath: sessionStorePath,
    readSource: sessionReadSource,
    entry: { ...baseEntry, worktree: worktreeEntry() },
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
  setWorktree(undefined);
  expect(await prepareGitHubPublicationAvailability(session)).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});

it.each([
  ["unbound", { worktree: undefined }],
  ["replaced-session", { sessionId: "replacement" }],
  ["replaced-lifecycle", { lifecycleRevision: "replacement" }],
  ["replaced-writer", { activeWriterRunId: "replacement" }],
] as const)(
  "uses the admitted store's current %s row instead of rediscovering another store",
  async (_kind, changes) => {
    const entry = { ...mocks.session().entry, activeWriterRunId: "writer", ...changes };
    mocks.admittedSessionRead.mockResolvedValue({
      entries: [{ sessionKey: session.sessionKey, entry }],
    });
    await expect(
      prepareGitHubPublicationWorkspaceOwner(session, {
        sessionTarget: {
          ...admittedTarget(),
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
        storePath: admittedSource.path,
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
  setWorktree(worktreeEntry(aliasWorktree));
  mocks.session.mockReturnValue({ ...mocks.session(), canonicalKey: "global" });
  const storedKey = "agent:main:main";
  mocks.admittedSessionRead.mockResolvedValue({
    entries: [{ sessionKey: storedKey, entry: mocks.session().entry }],
  });
  using prepared = await prepareGitHubPublicationWorkspaceOwner(
    { ...session, sessionKey: "global" },
    { sessionTarget: admittedTarget(storedKey) },
  );
  expect(prepared.initial.loaded.canonicalKey).toBe("global");
  expect(mocks.sessionRead).not.toHaveBeenCalled();
});

it.each(["session", "identity", "discovery"])(
  "keeps reads on the captured physical store across %s preparation",
  async (preparation) => {
    if (preparation === "identity") {
      mocks.identity.mockImplementationOnce(async () => {
        retargetStore();
        return identity;
      });
    } else if (preparation === "session") {
      mocks.sessionRead.mockImplementationOnce(async () => {
        retargetStore();
        return mocks.session();
      });
    }
    if (preparation === "discovery") {
      using prepared = await prepareGitHubPublicationSession(session.sessionKey, {
        agentId: session.agentId,
      });
      const readWorktree = registryRead.readLiveRegistryWorktreeByOwner;
      // Target discovery borrows the session; its registry read still retains the physical store.
      vi.spyOn(registryRead, "readLiveRegistryWorktreeByOwner").mockImplementationOnce(
        async (...args) => {
          retargetStore();
          return readWorktree(...args);
        },
      );
      expect(
        await hasSupportedGitHubPublicationTarget(session, () => {}, prepared.readCurrent),
      ).toBe(true);
    } else {
      expect(await prepareGitHubPublicationAvailability(session)).toBe(true);
    }
  },
);

it.each(["branch replacement", "turn cancellation and release"])(
  "qualifies memory-only private worktrees without host session SQL across %s",
  async (change) => {
    await using fixture = await memoryFixture(
      "agent:main:dashboard:incognito-publication-availability",
    );
    const { selected, location, actor } = fixture;
    mocks.session.mockImplementation(rejectHostRead);
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
              worktree: { ...worktreeEntry(), branch: "replacement" },
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
    }
  },
);

it("retains the memory session outside its async scope and rejects a replacement writer", async () => {
  await using fixture = await memoryFixture(
    "agent:main:dashboard:incognito-retained-writer",
    "writer",
  );
  const { selected, location, binding } = fixture;
  using prepared = await runWithSessionActorStorage(binding, () =>
    prepareGitHubPublicationWorkspaceOwner(selected, {
      sessionTarget: { ...selected, storePath: location.path, expectedWriterRunId: "writer" },
    }),
  );
  mocks.session.mockImplementation(rejectHostRead);
  expect((await prepared.read()).loaded.entry.activeWriterRunId).toBe("writer");
  await runWithSessionActorStorage(binding, () =>
    patchSessionEntryCore(
      { agentId: selected.agentId, sessionKey: selected.sessionKey, storePath: location.path },
      () => ({ activeWriterRunId: "replacement" }),
    ),
  );
  expect(() => prepared.current()).toThrow();
});

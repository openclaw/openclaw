import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  installManagedGitHubProfile,
  writeManagedGitHubProfileFiles,
  removeManagedGitHubProfile,
  resolveManagedGitHubProfileDir,
} from "../../agents/github-tool-identity.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { recordCommittedSessionMetadataPublication } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as turnClaims from "./placement-turn-claim-events.js";
import { bindWorkerGitHubTurn, prepareGitHubPublicationFact } from "./worker-github-binding.js";

async function prepareWorkerGitHubBinding(
  params: Parameters<typeof prepareGitHubPublicationFact>[0],
) {
  setRuntimeConfigSnapshot(config);
  return (await prepareGitHubPublicationFact(params))?.github;
}

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  refresh: vi.fn(),
  verify: vi.fn(),
  worktree: vi.fn(),
  worktreeRead: vi.fn(),
  repository: vi.fn(),
  repositoryWorkspace: vi.fn(),
  session: vi.fn(),
  admittedSessionRead: vi.fn(),
  nativeToken: vi.fn(),
  oauth: vi.fn(),
}));

vi.mock("../../agents/github-oauth-client.js", () => ({ verifyGitHubCredential: mocks.verify }));
vi.mock("../github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: mocks.refresh,
}));
vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: mocks.snapshot,
}));
vi.mock("../../agents/worktrees/service.js", () => ({
  managedWorktrees: {
    findLiveByOwner: mocks.worktree,
    resolveRepositoryIdentity: mocks.repository,
  },
}));
vi.mock("../../agents/worktrees/registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/worktrees/registry-read.js")>()),
  readLiveRegistryWorktreeByOwner: async (_context: unknown, kind: string, id: string) =>
    mocks.worktreeRead(kind, id),
}));
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  withSessionEntryReadOnlyInWorker: async <T>(
    scope: Parameters<
      typeof import("../../config/sessions/session-entry-read-runtime.js").withSessionEntryReadOnlyInWorker
    >[0],
    assertCurrent: () => void,
    consume: Parameters<
      typeof import("../../config/sessions/session-entry-read-runtime.js").withSessionEntryReadOnlyInWorker<T>
    >[2],
  ) => {
    const loaded = await mocks.admittedSessionRead(scope, assertCurrent);
    assertCurrent();
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
          databaseIdentity: "worker-github-binding-fixture",
        },
      },
    );
  },
}));
vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<
      typeof import("../session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >[0],
  ) => {
    const loaded = mocks.session(params.key, { agentId: params.agentId });
    params.onSelected?.({
      ...loaded,
      storeKeys: [loaded.canonicalKey],
      store: { [loaded.canonicalKey]: loaded.entry },
      capturedReadSource: {
        agentId: loaded.agentId,
        path: loaded.storePath ?? "/synthetic/admitted.sqlite",
        databaseIdentity: "worker-github-binding-fixture",
      },
    });
    return loaded;
  },
}));
vi.mock("../../config/sessions/session-entry-read-facts.js", async (original) => {
  const actual =
    await original<typeof import("../../config/sessions/session-entry-read-facts.js")>();
  return {
    ...actual,
    readRetainedSessionEntryFacts: ((database, request, owner) => {
      if (
        database.agentId !== session.agentId ||
        database.path !== "/synthetic/admitted.sqlite" ||
        !request.sessionKeys?.includes(session.sessionKey)
      ) {
        return actual.readRetainedSessionEntryFacts(database, request, owner);
      }
      return {
        kind: "session-exact-entries",
        source: {
          ...sessionReadSource,
          path: database.path,
          databaseIdentity: "worker-github-binding-fixture",
        },
        databaseIdentity: {
          identity: "worker-github-binding-fixture",
          incarnation: "synthetic",
          filename: database.path,
          canonicalPath: database.path,
        },
        entries: [{ sessionKey: session.sessionKey, entry: mocks.session().entry }],
        lifecycleTimestamps: {},
      };
    }) satisfies typeof actual.readRetainedSessionEntryFacts,
  };
});
vi.mock("../../state/session-repository-workspaces.js", () => ({
  getSessionRepositoryWorkspaceStore: () => ({
    prepare: async () => ({
      workspace: mocks.repositoryWorkspace(),
      current: mocks.repositoryWorkspace,
    }),
  }),
}));
// mock-isolation: Grant tests control OAuth expiry without reading the persistent credential store.
vi.mock("../../agents/github-oauth-records.js", () => ({ inspectGitHubOAuthRecord: mocks.oauth }));
vi.mock("../../process/exec.js", () => ({ runCommandBuffered: mocks.nativeToken }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const profileId = "ghp_11111111111111111111111111111111";
const token = "synthetic-worker-github-binding-token";
const sessionStorePath = "/worker-github-binding/sessions.sqlite";
const session = { sessionId: "worker-session", sessionKey: "agent:main:worker", agentId: "main" };
const sessionReadSource = {
  agentId: session.agentId,
  path: sessionStorePath,
  databaseIdentity: "synthetic-worker-github-binding",
};
const worktree = {
  id: "worker-worktree",
  path: "/repo/worktree",
  repoRoot: "/repo",
  repoFingerprint: "repository-fingerprint",
  branch: "openclaw/session-branch",
  ownerKind: "session",
  ownerId: session.sessionKey,
};
const verified = {
  status: "available" as const,
  account: { accountId: 42, login: "shared-bot", avatarUrl: null },
  scopes: [],
};
let config: OpenClawConfig;

async function installProfile(scope: "agent" | "system" = "system") {
  const profileDir = resolveManagedGitHubProfileDir({ agentId: "main", scope, profileId });
  await installManagedGitHubProfile({
    profileDir,
    token,
    commitConfig: async () => {},
  });
  mocks.verify.mockClear();
  return profileDir;
}

async function bindPreparedGrant(
  fact: Awaited<ReturnType<typeof prepareGitHubPublicationFact>>,
  assertCurrent = () => {},
) {
  // Renewal tests isolate turn attachment; placement-owner tests cover admission.
  using attachment = vi.spyOn(turnClaims, "bindWorkerTurnGitHubGrant");
  attachment.mockImplementation(() => {});
  const grant = await bindWorkerGitHubTurn({
    session,
    fact,
    sessionTarget: {
      ...session,
      storePath: "/synthetic/admitted.sqlite",
      expectedWriterRunId: "writer",
    },
    store: {
      prepareTurnClaimAuthority: async () => {
        throw new Error("Grant lifecycle tests do not acquire turn ownership");
      },
    },
    claim: {
      sessionId: session.sessionId,
      claimId: "grant-claim",
      runId: "grant-run",
      placementGeneration: 1,
      owner: { kind: "worker", environmentId: "grant-worker", ownerEpoch: 1 },
    },
    protocolFeatures: [WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE],
    signal: new AbortController().signal,
    assertCurrent,
  });
  if (!grant) {
    throw new Error("Expected prepared grant");
  }
  return grant;
}

async function prepareGrant(assertCurrent = () => {}, accessExpiresAtMs?: number) {
  const fact = await prepareGitHubPublicationFact(session);
  if (!fact?.github || !fact.identity || !fact.workspaceKey) {
    throw new Error("Expected background identity");
  }
  mocks.verify.mockClear();
  return bindPreparedGrant(
    {
      ...fact,
      identity: {
        ...fact.identity,
        ...(accessExpiresAtMs !== undefined ? { accessExpiresAtMs } : {}),
      },
    },
    assertCurrent,
  );
}

describe("worker GitHub launch binding", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("worker-github-binding-"));
    config = { tools: { github: { profileId, gitAuthor: { name: "Shared Bot" } } } };
    setRuntimeConfigSnapshot(config);
    mocks.snapshot.mockReset().mockImplementation(() => ({ config, sourceConfig: config }));
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    mocks.verify.mockReset().mockResolvedValue(verified);
    mocks.worktree.mockReset().mockReturnValue(worktree);
    mocks.worktreeRead.mockReset().mockImplementation(() => mocks.worktree());
    mocks.oauth.mockReset().mockResolvedValue({ state: "missing" });
    mocks.admittedSessionRead.mockReset().mockImplementation(async () => ({
      entries: [{ sessionKey: session.sessionKey, entry: mocks.session().entry }],
    }));
    mocks.repository.mockReset().mockResolvedValue({ originUrl: "git@github.com:owner/repo.git" });
    mocks.repositoryWorkspace.mockReset();
    mocks.session.mockReset().mockReturnValue({
      canonicalKey: session.sessionKey,
      agentId: "main",
      entry: {
        sessionId: session.sessionId,
        activeWriterRunId: "writer",
        worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
      },
    });
    mocks.nativeToken.mockReset().mockResolvedValue({
      code: 0,
      stdout: Buffer.from(token),
      stderr: Buffer.alloc(0),
    });
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("binds the verified shared account and canonical HTTPS remote", async () => {
    await installProfile();

    await expect(prepareWorkerGitHubBinding(session)).resolves.toEqual({
      token,
      login: "shared-bot",
      branch: worktree.branch,
      remoteUrl: "https://github.com/owner/repo.git",
      gitAuthor: { name: "Shared Bot" },
    });
    expect(mocks.verify).toHaveBeenCalledWith(token, {
      apiBaseUrl: "https://api.github.com",
    });
    expect(mocks.nativeToken).not.toHaveBeenCalled();
  });

  it("uses the agent override author without inheriting system author fields", async () => {
    config.agents = {
      entries: {
        main: { tools: { github: { profileId, gitAuthor: { email: "agent@example.test" } } } },
      },
    };
    await installProfile("agent");
    expect((await prepareWorkerGitHubBinding(session))?.gitAuthor).toEqual({
      email: "agent@example.test",
    });
  });

  it.each([{ name: "Shared\nBot" }, { email: "a".repeat(257) }])(
    "omits launch-invalid author metadata instead of failing the worker turn: %j",
    async (gitAuthor) => {
      config = { tools: { github: { profileId, gitAuthor } } };
      await installProfile();
      await expect(prepareWorkerGitHubBinding(session)).resolves.toBeUndefined();
    },
  );

  it("binds native shared auth without a managed author or non-GitHub remote", async () => {
    config = {};
    mocks.repository.mockResolvedValue({ originUrl: "https://example.test/owner/repo.git" });
    await expect(prepareWorkerGitHubBinding(session)).resolves.toEqual({
      token,
      login: "shared-bot",
      branch: worktree.branch,
    });
  });

  it.each(["missing-profile", "unavailable"] as const)(
    "omits credentials when the managed identity is %s",
    async (failure) => {
      if (failure !== "missing-profile") {
        await installProfile();
        mocks.verify.mockResolvedValue({ status: failure });
      }
      await expect(prepareWorkerGitHubBinding(session)).resolves.toBeUndefined();
      expect(mocks.nativeToken).not.toHaveBeenCalled();
    },
  );

  it.each(["before-preparation", "verification", "repository"])(
    "omits the binding after claim closure during %s",
    async (phase) => {
      await installProfile();
      let current = phase !== "before-preparation";
      mocks.verify.mockImplementation(async () => {
        if (phase === "verification") {
          current = false;
        }
        return verified;
      });
      mocks.repository.mockImplementation(async () => {
        current = false;
        return { originUrl: "git@github.com:owner/repo.git" };
      });
      await expect(
        prepareWorkerGitHubBinding({ ...session, assertCurrent: () => current }),
      ).resolves.toBeUndefined();
      if (phase === "before-preparation") {
        expect(mocks.verify).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["identity", "worktree"])(
    "rejects a %s replacement during repository lookup",
    async (replaced) => {
      await installProfile();
      mocks.repository.mockImplementation(async () => {
        if (replaced === "identity") {
          config = { tools: { github: { profileId: "ghp_22222222222222222222222222222222" } } };
        } else {
          mocks.worktree.mockReturnValue({ ...worktree, repoFingerprint: "replacement" });
        }
        return { originUrl: "git@github.com:owner/repo.git" };
      });
      await expect(prepareWorkerGitHubBinding(session)).resolves.toBeUndefined();
    },
  );

  it("publishes a refreshed profile on the next background preparation", async () => {
    const profileDir = await installProfile();
    const first = await prepareWorkerGitHubBinding(session);
    await fs.rm(profileDir, { recursive: true });
    const rotated = "synthetic-worker-github-rotated-token";
    await installManagedGitHubProfile({ profileDir, token: rotated, commitConfig: async () => {} });
    expect(first?.token).toBe(token);
    expect((await prepareWorkerGitHubBinding(session))?.token).toBe(rotated);
  });

  it.each(["current", "replaced", "revoked"] as const)(
    "binds a repository-only session before first checkout while authority is %s",
    async (state) => {
      await installProfile();
      const repository = {
        workspaceId: "repository-workspace",
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        url: "https://github.com/owner/repo.git",
        branch: "openclaw/repository-session",
        baseCommit: null,
        checkpointRef: null,
      };
      mocks.session.mockReturnValue({
        canonicalKey: session.sessionKey,
        agentId: session.agentId,
        entry: { sessionId: session.sessionId, repositoryWorkspaceId: repository.workspaceId },
      });
      mocks.repositoryWorkspace.mockReturnValue(repository);
      let current = true;
      mocks.verify.mockImplementation(async () => {
        if (state === "revoked") {
          current = false;
        }
        if (state === "replaced") {
          mocks.repositoryWorkspace.mockReturnValue({
            ...repository,
            url: "https://github.com/other/repo.git",
          });
        }
        return verified;
      });
      const binding = await prepareWorkerGitHubBinding({
        ...session,
        assertCurrent: () => current,
      });
      if (state === "current") {
        expect(binding).toMatchObject({
          token,
          branch: repository.branch,
          remoteUrl: repository.url,
        });
      } else {
        expect(binding).toBeUndefined();
      }
      expect(mocks.repository).not.toHaveBeenCalled();
      expect(mocks.worktree).not.toHaveBeenCalled();
    },
  );
  it("rejects an older worker before disclosing the prepared credential", async () => {
    await installProfile();
    const fact = await prepareGitHubPublicationFact(session);
    expect(fact?.github).toBeDefined();
    mocks.verify.mockClear();
    await expect(
      bindWorkerGitHubTurn({
        session,
        fact,
        sessionTarget: { ...session, storePath: "/synthetic/admitted.sqlite" },
        store: {
          prepareTurnClaimAuthority: async () => {
            throw new Error("older worker must not acquire a grant");
          },
        },
        claim: {
          sessionId: session.sessionId,
          claimId: "old-worker-claim",
          runId: "old-worker-run",
          placementGeneration: 1,
          owner: { kind: "worker", environmentId: "old-worker", ownerEpoch: 1 },
        },
        protocolFeatures: [],
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).rejects.toThrow("redispatch the session");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("binds a repository credential without synchronous identity discovery", async () => {
    await installProfile();
    const grant = await prepareGrant();
    try {
      expect(grant.binding.token).toBe(token);
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(await grant.refresh(0)).toBeUndefined();
      expect(mocks.verify).not.toHaveBeenCalled();
    } finally {
      await grant.revoke();
    }
  });

  it.each(["sessionId", "activeWriterRunId", "lifecycleRevision"] as const)(
    "rejects retained renewal after the admitted %s changes",
    async (field) => {
      await installProfile();
      const grant = await prepareGrant();
      try {
        recordCommittedSessionMetadataPublication(
          "worker-github-binding-fixture",
          session.sessionKey,
          undefined,
          { ...mocks.session().entry, [field]: "replacement" },
        );
        await expect(grant.refresh()).rejects.toThrow();
        expect(grant.signal.aborted).toBe(true);
        expect(mocks.verify).not.toHaveBeenCalled();
      } finally {
        await grant.revoke();
      }
    },
  );

  it("renews one selected account, replays until installed, and revokes on removal", async () => {
    const profileDir = await installProfile();
    const grant = await prepareGrant();
    try {
      await writeManagedGitHubProfileFiles(profileDir, {
        login: verified.account.login,
        token: "synthetic-renewal",
      });
      const update = await grant.refresh(0);
      expect(update).toMatchObject({ generation: 1, token: "synthetic-renewal" });
      expect(await grant.refresh(0)).toEqual(update);
      expect(await grant.refresh(1)).toBeUndefined();
      await removeManagedGitHubProfile(profileDir);
      expect(grant.signal.aborted).toBe(true);
      await expect(grant.refresh()).rejects.toThrow();
    } finally {
      await grant.revoke();
    }
  });

  it("renews a near-expiry credential and fails closed when renewal is unavailable", async () => {
    await installProfile();
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const grant = await prepareGrant(() => {}, now + 1_000);
    try {
      mocks.verify.mockRejectedValue(new Error("issuer unavailable"));
      expect(await grant.refresh()).toBeUndefined();
      expect(mocks.verify).toHaveBeenCalledTimes(1);
      expect(grant.signal.aborted).toBe(false);
      vi.setSystemTime(now + 1_001);
      await expect(grant.refresh()).rejects.toThrow("issuer unavailable");
      expect(grant.signal.aborted).toBe(true);
    } finally {
      await grant.revoke();
    }
  });

  it("refuses a revoked retained caller across renewal", async () => {
    const profileDir = await installProfile();
    let allowed = true;
    const grant = await prepareGrant(() => {
      if (!allowed) {
        throw new Error("caller denied");
      }
    });
    const entered = createDeferred();
    const release = createDeferred();
    try {
      await writeManagedGitHubProfileFiles(profileDir, {
        login: verified.account.login,
        token: "synthetic-late-renewal",
      });
      mocks.verify.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return verified;
      });
      const renewing = grant.refresh();
      await entered.promise;
      allowed = false;
      release.resolve();
      await expect(renewing).rejects.toThrow("caller denied");
      expect(grant.signal.aborted).toBe(true);
    } finally {
      release.resolve();
      await grant.revoke();
    }
  });

  it("does not expand credentials to a session without a repository", async () => {
    await installProfile();
    const fact = await prepareGitHubPublicationFact(session);
    if (!fact?.github || !fact.identity || !fact.workspaceKey) {
      throw new Error("Expected identity");
    }
    mocks.session.mockReturnValue({
      ...mocks.session(),
      entry: { sessionId: session.sessionId, activeWriterRunId: "writer" },
    });
    await expect(bindPreparedGrant(fact)).rejects.toThrow();
  });
});

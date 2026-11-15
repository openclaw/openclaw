import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  GitHubIdentityError,
  installManagedGitHubProfile,
  writeManagedGitHubProfileFiles,
  removeManagedGitHubProfile,
} from "../../agents/github-tool-identity.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { recordCommittedSessionMetadataPublication } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RepositoryIntegration } from "../../plugins/repository-integration.types.js";
import type { RepositoryCredentialSource } from "../github-user-identity.types.js";
import { prepareWorkerGitHubBindingGrant } from "./worker-github-execution-identity.js";
const policy = vi.hoisted(() => ({ current: undefined as RepositoryIntegration | undefined }));
vi.mock("../../plugins/repository-integration-runtime.js", () => ({
  getRepositoryIntegration: () => policy.current,
}));
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import { bindWorkerGitHubTurn, prepareGitHubPublicationFact } from "./worker-github-binding.js";
import {
  workerGitHubFixture,
  createWorkerGitHubBindingFixture,
} from "./worker-github-binding.test-support.js";

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
// Resident profile facts and external HTTP are fixtures; proof issuance and redemption stay real.
vi.mock("../../state/user-profile-list.js", async (original) => ({
  ...(await original<typeof import("../../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: () => ({
    readCurrentFacts: () => ({
      profileId: "operator-profile",
      emails: [`github:${config.gateway?.github?.host ?? "github.com"}:77`],
    }),
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { profileId, token, session, sessionReadSource, worktree, verified } = workerGitHubFixture;
let config: OpenClawConfig;

const { installProfile, prepareGrant, bindPreparedGrant } = createWorkerGitHubBindingFixture({
  session,
  profileId,
  token,
  resetVerification: () => mocks.verify.mockClear(),
});

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
    policy.current = undefined;
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not discover host credentials without a selected worker GitHub identity", async () => {
    config = {};
    setRuntimeConfigSnapshot(config);
    mocks.nativeToken.mockRejectedValue(new Error("Optional host CLI is unavailable"));
    await expect(prepareWorkerGitHubBindingGrant(session)).resolves.toBeUndefined();
    expect(mocks.nativeToken).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    await expect(
      prepareWorkerGitHubBindingGrant({ ...session, expectedProfileId: profileId }),
    ).rejects.toThrow("Selected GitHub App changed");
  });

  it.each([
    "missing profile",
    "unavailable managed identity",
    "unavailable native identity",
    "no identity",
    "invalid author",
    "closed placement",
  ] as const)("repository checkout identity: %s", async (scenario) => {
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    if (scenario === "unavailable managed identity" || scenario === "invalid author") {
      await installProfile();
      if (scenario === "invalid author") {
        config.tools!.github!.gitAuthor = { name: "Invalid\nAuthor" };
      } else {
        mocks.verify.mockResolvedValue({ status: "unavailable" });
      }
    }
    if (scenario === "no identity" || scenario === "unavailable native identity") {
      config = {};
      mocks.nativeToken.mockImplementation(async (argv: string[]) => ({
        code: argv[2] === "token" ? 1 : 0,
        termination: "exit",
        stdout: Buffer.from(
          scenario === "no identity" ? '{"hosts":{}}' : '{"hosts":{"github.com":[{}]}}',
        ),
        stderr: Buffer.alloc(0),
      }));
    }
    setRuntimeConfigSnapshot(config);
    const reachedSync = new Error("repository sync reached");
    const syncWorkspace = vi
      .fn<WorkerTunnelHandle["syncWorkspace"]>()
      .mockRejectedValue(reachedSync);
    const tunnel: WorkerTunnelHandle = {
      environmentId: "identity-test",
      ownerEpoch: 1,
      runWorkspaceCommand: vi.fn(),
      stop: vi.fn(),
      quiesceWorkspace: vi.fn(),
      reconcileWorkspace: vi.fn(),
      syncWorkspace,
    };
    const operation = syncSessionRepositoryWorkspace({
      ...session,
      generation: 1,
      repository: {
        ...session,
        workspaceId: "identity-test",
        url: "https://github.com/example/repository.git",
        requestedRef: null,
        branch: "openclaw/identity-test",
        runSetupScript: false,
        baseCommit: null,
        baseManifestHash: null,
        checkpointRef: null,
        manifestHash: null,
        revision: 1,
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      tunnel,
      assertCurrent: () => {
        if (scenario === "closed placement") {
          throw new Error("placement closed");
        }
      },
    });
    if (scenario === "no identity" || scenario === "invalid author") {
      await expect(operation).rejects.toBe(reachedSync);
      const source = syncWorkspace.mock.calls[0]?.[0].source;
      if (scenario === "no identity") {
        expect(source).not.toHaveProperty("gitToken");
      } else {
        expect(source).toHaveProperty("gitToken", token);
      }
    } else {
      if (scenario === "closed placement") {
        await expect(operation).rejects.toThrow("placement closed");
      } else {
        await expect(operation).rejects.toBeInstanceOf(GitHubIdentityError);
        await expect(operation).rejects.toThrow(/reconnect/iu);
      }
      expect(syncWorkspace).not.toHaveBeenCalled();
    }
  });

  it("retains and rechecks the admitted original operator independently of the turn owner", async () => {
    await installProfile();
    let current = true;
    const release = vi.fn();
    const retain = vi.fn(() => release);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "original-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (!current) {
          throw new Error("Original operator revoked");
        }
      },
      retain,
    });
    const fact = await prepareGitHubPublicationFact(session);
    const grant = await bindPreparedGrant(fact, () => undefined, operatorAuthority);
    try {
      expect(retain).toHaveBeenCalledOnce();
      current = false;
      expect(() => grant.assertCurrent()).toThrow("Original operator revoked");
      await expect(grant.refresh()).rejects.toThrow();
    } finally {
      await grant.revoke();
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["github.com", true],
    ["github.com", false],
    ["enterprise.ghe.com", false],
  ] as const)("binds discovered host %s (managed=%s)", async (host, managed) => {
    if (managed) {
      await installProfile();
    } else {
      config = {};
    }
    config.gateway = { github: { host, apiBaseUrl: `https://api.${host}` } };
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    vi.stubEnv("GH_ENTERPRISE_TOKEN", undefined);
    vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", undefined);
    const canonicalRemote = managed || host !== "github.com";
    mocks.repository.mockResolvedValue({
      originUrl: canonicalRemote
        ? `git@${host}:owner/repo.git`
        : "https://example.test/owner/repo.git",
    });
    await expect(prepareWorkerGitHubBinding(session)).resolves.toEqual({
      token,
      host,
      login: "shared-bot",
      branch: worktree.branch,
      ...(canonicalRemote ? { remoteUrl: `https://${host}/owner/repo.git` } : {}),
      ...(managed ? { gitAuthor: { name: "Shared Bot" } } : {}),
    });
    expect(mocks.verify).toHaveBeenCalledWith(token, { apiBaseUrl: `https://api.${host}` });
    if (managed) {
      expect(mocks.nativeToken).not.toHaveBeenCalled();
    }
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
    "omits the optional launch binding for invalid author metadata: %j",
    async (gitAuthor) => {
      config = { tools: { github: { profileId, gitAuthor } } };
      await installProfile();
      await expect(prepareWorkerGitHubBinding(session)).resolves.toBeUndefined();
    },
  );

  it.each(["missing-profile", "unavailable"] as const)(
    "keeps publication discovery optional when the managed identity is %s",
    async (failure) => {
      if (failure !== "missing-profile") {
        await installProfile();
        mocks.verify.mockResolvedValue({ status: failure });
      }
      await expect(prepareWorkerGitHubBinding(session)).resolves.toBeUndefined();
      await expect(prepareWorkerGitHubBindingGrant(session)).rejects.toBeInstanceOf(
        GitHubIdentityError,
      );
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
          setRuntimeConfigSnapshot(config);
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
  it.each(["shared", "integration"])(
    "rejects an older $0 worker before disclosing the prepared credential",
    async (mode) => {
      await installProfile();
      const fact = await prepareGitHubPublicationFact(session);
      expect(fact?.github).toBeDefined();
      if (mode === "integration") {
        policy.current = {
          version: 1,
          preparedCapacity: "image",
          resolveConnectionIdentity: () => undefined,
          withIdentity: async () => {
            throw new Error("Older worker must not enter integration policy");
          },
        };
      }
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
    },
  );

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

// Native token delivery and publication/session owners remain real; external integration policy is a fixture.
describe("same-bound integrated worker credential renewal", () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  async function fixture(
    host: string,
    apiBaseUrl: string,
    throughTurn = false,
    sourceLifetime: "valid" | "missing" | "expired" | "short" = "valid",
  ) {
    vi.useFakeTimers();
    const now = Date.now();
    const selected = {
      profileId,
      kind: "app-installation" as const,
      app: {
        appId: 101,
        installationId: 202,
        accountId: 303,
        repositories: [{ id: 404, fullName: "example/project" }],
        permissions: { contents: "write" as const },
        privateKey,
        keyVersion: "test-v1",
      },
    };
    config = { gateway: { github: { host, apiBaseUrl } }, tools: { github: selected } };
    setRuntimeConfigSnapshot(config);
    mocks.snapshot.mockImplementation(() => ({ config, sourceConfig: config }));
    mocks.refresh.mockResolvedValue(undefined);
    mocks.session.mockReturnValue({
      canonicalKey: session.sessionKey,
      agentId: session.agentId,
      entry: { sessionId: session.sessionId },
    });
    const credentialSource: RepositoryCredentialSource | undefined =
      sourceLifetime === "missing"
        ? undefined
        : Object.freeze({
            id: `${host === "engineering.ghe.com" ? "browser" : "ahp"}:${"a".repeat(64)}`,
            expiresAtMs:
              now +
              (sourceLifetime === "expired"
                ? -1
                : sourceLifetime === "short"
                  ? 55 * 60_000
                  : 2 * 3_600_000),
          });

    let issued = 0;
    let status = 200;
    let botId = 9001;
    let reuseToken = false;
    let onMint: (() => Promise<void>) | undefined;
    const removed: string[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const pathname = url.slice(apiBaseUrl.length);
      if (!url.startsWith(apiBaseUrl)) {
        throw new Error("Wrong GitHub issuer");
      }
      if (init.method === "DELETE") {
        removed.push(String(new Headers(init.headers).get("authorization")));
        return new Response(null, { status: 204 });
      }
      if (status !== 200) {
        return new Response(null, { status });
      }
      if (pathname.endsWith("/access_tokens")) {
        await onMint?.();
        issued++;
        return Response.json({
          token: `synthetic-app-${reuseToken ? 1 : issued}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { contents: "write", metadata: "read" },
        });
      }
      const bodies: Record<string, unknown> = {
        "/app": { id: 101, slug: "factory", permissions: { contents: "write", metadata: "read" } },
        "/app/installations/202": {
          id: 202,
          app_id: 101,
          account: { id: 303 },
          suspended_at: null,
          permissions: { contents: "write", metadata: "read" },
        },
        "/users/factory%5Bbot%5D": {
          id: botId,
          login: "factory[bot]",
          type: "Bot",
          avatar_url: null,
        },
        "/installation/repositories?per_page=100": {
          total_count: 1,
          repositories: [{ id: 404, full_name: "example/project" }],
        },
      };
      return Response.json(bodies[pathname]);
    });
    vi.stubGlobal("fetch", fetcher);
    const admissions = vi.fn(async (_source: typeof credentialSource) => {});
    policy.current = {
      version: 1,
      preparedCapacity: "image",
      resolveConnectionIdentity: () => undefined,
      async withIdentity(context, run) {
        const originalSource = context.actor.credentialSource;
        const assertCurrent = () => {
          context.assertCurrent();
          if (!originalSource || originalSource.expiresAtMs <= Date.now()) {
            throw new Error("Original repository credential source is unavailable");
          }
        };
        assertCurrent();
        return run({
          env: context.env,
          assertCurrent,
          readNativeCredential: async (_env, admission) => {
            assertCurrent();
            expect(admission).toMatchObject({ kind: "repository-admission", host });
            await admissions(originalSource);
            assertCurrent();
            return undefined;
          },
        });
      },
    };
    const controller = new AbortController();
    const operator = createAdmittedRunOperatorAuthority({
      profileId: "operator-profile",
      repositoryCredentialSource: credentialSource,
      scopes: ["operator.write"],
      signal: controller.signal,
      assertCurrent() {},
    });
    const grant = throughTurn
      ? await bindPreparedGrant(undefined, () => {}, operator)
      : await prepareWorkerGitHubBindingGrant({ ...session, operatorAuthority: operator });
    if (!grant) {
      throw new Error("Expected admitted grant");
    }
    return {
      grant,
      now,
      removed,
      admissions,
      fetcher,
      controller,
      credentialSource,
      get issued() {
        return issued;
      },
      setStatus(value: number) {
        status = value;
      },
      changeAccount() {
        botId++;
      },
      reuseToken() {
        reuseToken = true;
      },
      onMint(value: () => Promise<void>) {
        onMint = value;
      },
    };
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    policy.current = undefined;
    clearRuntimeConfigSnapshot();
  });

  it.each([
    { host: "engineering.ghe.com", api: "https://api.engineering.ghe.com" },
    { host: "microsoft.ghe.com", api: "https://api.microsoft.ghe.com" },
  ])(
    "binds worker turns to the admitted operator without an ambient caller on $host",
    async ({ host, api }) => {
      const h = await fixture(host, api, true);
      expect(h.grant.binding.host).toBe(host);
      expect(h.issued).toBe(1);
      h.controller.abort();
      expect(() => h.grant.assertCurrent()).toThrow();
      await expect(h.grant.refresh(0)).rejects.toThrow();
      await h.grant.revoke();
    },
  );

  it.each([
    { host: "engineering.ghe.com", api: "https://api.engineering.ghe.com" },
    { host: "microsoft.ghe.com", api: "https://api.microsoft.ghe.com" },
  ])(
    "crosses the old expiry only after same-account installation ACK on $host",
    async ({ host, api }) => {
      const h = await fixture(host, api);
      try {
        expect(h.grant.binding.host).toBe(host);
        await vi.advanceTimersByTimeAsync(55 * 60_000);
        const [first, concurrent] = await Promise.all([h.grant.refresh(0), h.grant.refresh(0)]);
        expect(first).toMatchObject({ generation: 1, token: "synthetic-app-2" });
        expect(concurrent).toEqual(first);
        expect(h.issued).toBe(2);
        expect(await h.grant.refresh(0)).toEqual(first);
        expect(h.removed).toEqual([]);
        await h.grant.refresh(1);
        expect(h.removed).toEqual([]);
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        expect(() => h.grant.assertCurrent()).not.toThrow();
        expect(h.grant.signal.aborted).toBe(false);
        expect(h.admissions).toHaveBeenCalledTimes(2);
        expect(h.admissions.mock.calls[0]?.[0]).toBe(h.credentialSource);
        expect(h.admissions.mock.calls[1]?.[0]).toBe(h.credentialSource);
      } finally {
        await h.grant.revoke();
      }
      expect(h.removed).toEqual(["Bearer synthetic-app-1", "Bearer synthetic-app-2"]);
      await expect(h.grant.refresh(1)).rejects.toThrow();
    },
  );

  it.each(["missing", "expired"] as const)(
    "refuses an initially %s original source before broker lookup or App issuance",
    async (sourceLifetime) => {
      await expect(
        fixture("microsoft.ghe.com", "https://api.microsoft.ghe.com", false, sourceLifetime),
      ).rejects.toThrow("Original repository credential source is unavailable");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("refuses renewal after original source expiry without selecting another credential", async () => {
    const h = await fixture("microsoft.ghe.com", "https://api.microsoft.ghe.com", false, "short");
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    await expect(h.grant.refresh(0)).rejects.toThrow(
      "Original repository credential source is unavailable",
    );
    await h.grant.revoke();
    expect(h.issued).toBe(1);
    expect(h.admissions).toHaveBeenCalledOnce();
    expect(h.removed).toEqual(["Bearer synthetic-app-1"]);
  });

  it("refuses renewal when the original source is denied by its broker owner", async () => {
    const h = await fixture("microsoft.ghe.com", "https://api.microsoft.ghe.com");
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    h.admissions.mockRejectedValueOnce(new Error("Integration admission refused"));
    await expect(h.grant.refresh(0)).rejects.toThrow();
    await h.grant.revoke();
    expect(h.issued).toBe(1);
    expect(h.removed).toEqual(["Bearer synthetic-app-1"]);
  });

  it("does not extend or revoke an unchanged bearer returned by the issuer", async () => {
    const h = await fixture("engineering.ghe.com", "https://api.engineering.ghe.com");
    h.reuseToken();
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(await h.grant.refresh(0)).toBeUndefined();
    expect(h.removed).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.grant.signal.aborted).toBe(true);
    await h.grant.revoke();
    expect(h.removed).toEqual(["Bearer synthetic-app-1"]);
  });

  it("keeps the original deadline without an installation ACK", async () => {
    const h = await fixture("engineering.ghe.com", "https://api.engineering.ghe.com");
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(await h.grant.refresh(0)).toMatchObject({ generation: 1 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.grant.signal.aborted).toBe(true);
    await h.grant.revoke();
    expect(h.removed).toContain("Bearer synthetic-app-2");
  });

  it("bounds transient retries by polling and the installed credential expiry", async () => {
    const h = await fixture("engineering.ghe.com", "https://api.engineering.ghe.com");
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    h.setStatus(503);
    expect(await h.grant.refresh(0)).toBeUndefined();
    const attempted = h.fetcher.mock.calls.length;
    expect(await h.grant.refresh(0)).toBeUndefined();
    expect(h.fetcher).toHaveBeenCalledTimes(attempted);
    await vi.advanceTimersByTimeAsync(30_000);
    h.setStatus(200);
    expect(await h.grant.refresh(0)).toMatchObject({ generation: 1 });
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.grant.signal.aborted).toBe(true);
    await h.grant.revoke();
  });

  it.each(["host", "api", "account", "operator", "closed", "denied"])(
    "refuses renewal after %s changes without adopting another credential",
    async (change) => {
      const h = await fixture("microsoft.ghe.com", "https://api.microsoft.ghe.com");
      await vi.advanceTimersByTimeAsync(55 * 60_000);
      if (change === "host") {
        config.gateway!.github!.host = "github.com";
      }
      if (change === "api") {
        config.gateway!.github!.apiBaseUrl = "https://other.example/api/v3";
      }
      if (change === "account") {
        h.changeAccount();
      }
      if (change === "operator") {
        h.controller.abort();
      }
      if (change === "closed") {
        await h.grant.revoke();
      }
      if (change === "denied") {
        h.setStatus(403);
      }
      await expect(h.grant.refresh(0)).rejects.toThrow();
      expect(h.grant.signal.aborted).toBe(true);
      await h.grant.revoke();
      expect(h.issued).toBe(change === "account" ? 2 : 1);
    },
  );

  it("settles late token issuance during turn closure before credential cleanup completes", async () => {
    const h = await fixture("engineering.ghe.com", "https://api.engineering.ghe.com");
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    const entered = createDeferred();
    const release = createDeferred();
    h.onMint(async () => {
      entered.resolve();
      await release.promise;
    });
    const renewing = h.grant.refresh(0);
    await entered.promise;
    const closed = h.grant.revoke();
    release.resolve();
    await expect(renewing).rejects.toThrow();
    await closed;
    expect(h.removed).toContain("Bearer synthetic-app-2");
    expect(h.removed).toContain("Bearer synthetic-app-1");
  });
});

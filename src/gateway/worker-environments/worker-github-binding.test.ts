import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  installManagedGitHubProfile,
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../../agents/github-tool-identity.js";
import * as configModule from "../../config/config.js";
import { createConfigFileSnapshot } from "../../config/io.snapshot-shared.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { redeemFactoryGitHubProof } from "../factory-github-proof.js";
import {
  prepareWorkerGitHubBindingGrant,
  prepareWorkerRepositoryGitHubIdentity,
} from "./worker-github-binding.js";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  refresh: vi.fn(),
  verify: vi.fn(),
  worktree: vi.fn(),
  repository: vi.fn(),
  repositoryWorkspace: vi.fn(),
  session: vi.fn(),
  nativeToken: vi.fn(),
  oauth: vi.fn(),
  profile: vi.fn(),
  profileFacts: vi.fn(),
  releaseProfile: vi.fn(),
}));
vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  prepareUserProfileIdentity: mocks.profile,
  getUserProfileDisplay: () => ({ displayName: "Operator" }),
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
    mocks.worktree(kind, id),
}));
vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<
      typeof import("../session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >[0],
  ) => mocks.session(params.key, { agentId: params.agentId }),
}));
vi.mock("../session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: mocks.session }));
vi.mock("../../state/session-repository-workspaces.js", () => ({
  getSessionRepositoryWorkspaceStore: () => ({
    prepare: async () => ({
      workspace: mocks.repositoryWorkspace(),
      current: mocks.repositoryWorkspace,
    }),
  }),
}));
vi.mock("../../agents/github-oauth-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/github-oauth-records.js")>()),
  inspectGitHubOAuthRecord: mocks.oauth,
}));
vi.mock("../../process/exec.js", () => ({ runCommandBuffered: mocks.nativeToken }));

async function prepareBinding(params: Parameters<typeof prepareWorkerGitHubBindingGrant>[0]) {
  const grant = await prepareWorkerGitHubBindingGrant(params);
  try {
    return grant?.binding;
  } finally {
    await grant?.revoke();
  }
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const profileId = "ghp_11111111111111111111111111111111";
const token = "synthetic-worker-github-binding-token";
const session = { sessionId: "worker-session", sessionKey: "agent:main:worker", agentId: "main" };
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

describe("worker GitHub launch binding", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("worker-github-binding-"));
    config = { tools: { github: { profileId, gitAuthor: { name: "Shared Bot" } } } };
    setRuntimeConfigSnapshot(config);
    mocks.snapshot.mockReset().mockImplementation(() => ({ config, sourceConfig: config }));
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    mocks.oauth.mockReset().mockReturnValue({ state: "missing" });
    mocks.verify.mockReset().mockResolvedValue(verified);
    mocks.worktree.mockReset().mockReturnValue(worktree);
    mocks.repository.mockReset().mockResolvedValue({ originUrl: "git@github.com:owner/repo.git" });
    mocks.repositoryWorkspace.mockReset();
    mocks.session.mockReset().mockReturnValue({
      canonicalKey: session.sessionKey,
      agentId: "main",
      entry: {
        sessionId: session.sessionId,
        worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
      },
    });
    mocks.nativeToken.mockReset().mockResolvedValue({
      code: 0,
      stdout: Buffer.from(token),
      stderr: Buffer.alloc(0),
    });
    mocks.releaseProfile.mockReset();
    mocks.profileFacts.mockReset().mockReturnValue({
      profile: { emails: ["github:microsoft.ghe.com:101", "operator@example.test"] },
    });
    mocks.profile.mockReset().mockResolvedValue({
      emailBindingIds: ["operator-binding"],
      readCurrentFacts: mocks.profileFacts,
      release: mocks.releaseProfile,
    });
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    setLoggerOverride(null);
    resetLogger();
  });

  it.each([false, true])(
    "keeps Factory caller custody separate from configured bot execution (bot author=%s)",
    async (botAuthor) => {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      if (botAuthor) {
        config.tools!.github!.gitAuthor = { name: "Shared Bot", email: "bot@example.test" };
      } else {
        delete config.tools!.github!.gitAuthor;
      }
      await installProfile();
      const capture = createDiagnosticLogRecordCapture();
      setLoggerOverride({
        level: "warn",
        consoleLevel: "silent",
        file: `${tempDirs.make("worker-github-denial-")}/denial.log`,
      });
      const privateSessionKey = "agent:main:synthetic-private-user-content";
      try {
        await expect(
          prepareWorkerGitHubBindingGrant({ ...session, sessionKey: privateSessionKey }),
        ).rejects.toThrow("verified operator and session");
        await capture.flush();
        expect(capture.records).toEqual([
          expect.objectContaining({
            message: "worker_github_operator_unavailable",
            attributes: expect.objectContaining({
              origin: "unknown",
              explicitOperator: false,
              ambientCaller: false,
              ambientOperator: false,
              agentMatch: false,
              keyMatch: false,
            }),
          }),
        ]);
        expect(JSON.stringify(capture.records)).not.toContain(privateSessionKey);
        expect(JSON.stringify(capture.records)).not.toContain(token);
        expect(mocks.session).not.toHaveBeenCalled();
      } finally {
        capture.cleanup();
      }
      const operator = createAdmittedRunOperatorAuthority({
        profileId: "operator",
        scopes: ["operator.write"],
        assertCurrent: () => {},
      });
      const grant = await prepareWorkerGitHubBindingGrant({
        ...session,
        operatorAuthority: operator,
      });
      try {
        expect(grant?.binding).toMatchObject({
          token,
          login: "shared-bot",
          gitAuthor: botAuthor
            ? { name: "Shared Bot", email: "bot@example.test" }
            : { name: "Operator", email: "operator@example.test" },
        });
        expect(mocks.nativeToken).not.toHaveBeenCalled();
        expect(mocks.profileFacts).toHaveBeenCalledWith(["operator-binding"]);
        expect(mocks.releaseProfile).not.toHaveBeenCalled();
        mocks.profileFacts.mockImplementation(() => {
          throw new Error("operator email binding revoked");
        });
        expect(() => grant?.assertCurrent?.()).toThrow("operator email binding revoked");
      } finally {
        await grant?.revoke();
      }
      expect(mocks.releaseProfile).toHaveBeenCalledOnce();
    },
  );

  it("delivers only the scoped App bot credential while retaining original human admission, attribution and renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    config.tools!.github = {
      profileId,
      kind: "app-installation",
      app: {
        appId: 13361,
        installationId: 119386,
        accountId: 185961,
        repositories: [{ id: 1044511, fullName: "bic/lobster" }],
        permissions: { contents: "write", metadata: "read" },
        privateKey,
        keyVersion: "synthetic-v1",
      },
    };
    let issued = 0;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("repository-admission")) {
        const verdict = redeemFactoryGitHubProof(
          String((init.headers as Record<string, string>)["x-factory-github-proof"]),
        );
        return Response.json({
          version: 1,
          kind: "repository-admission",
          host: "github.com",
          appId: 13361,
          installationId: 119386,
          repository: { id: 1044511, fullName: "bic/lobster" },
          actor: { accountId: verdict.actorId, profileId: verdict.profileId },
          purpose: verdict.purpose,
          binding: verdict.binding,
          expiresAtMs: Date.now() + 60_000,
        });
      }
      if (url.endsWith("/app")) {
        return Response.json({
          id: 13361,
          slug: "factory",
          permissions: { contents: "write", metadata: "read" },
        });
      }
      if (url.endsWith("/app/installations/119386")) {
        return Response.json({
          id: 119386,
          app_id: 13361,
          account: { id: 185961 },
          suspended_at: null,
          permissions: { contents: "write", metadata: "read" },
        });
      }
      if (url.endsWith("/access_tokens")) {
        return Response.json({
          token: `synthetic-app-worker-${++issued}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { contents: "write", metadata: "read" },
        });
      }
      if (url.includes("/users/")) {
        return Response.json({ id: 9001, login: "factory[bot]", type: "Bot", avatar_url: null });
      }
      if (url.includes("/installation/repositories")) {
        return Response.json({
          total_count: 1,
          repositories: [{ id: 1044511, full_name: "bic/lobster" }],
        });
      }
      throw new Error("Unexpected App request");
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "synthetic-password");
    const operator = createAdmittedRunOperatorAuthority({
      profileId: "operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    const grant = await prepareWorkerGitHubBindingGrant({
      ...session,
      operatorAuthority: operator,
    });
    try {
      expect(grant?.binding).toMatchObject({
        token: "synthetic-app-worker-1",
        login: "factory[bot]",
        executionKind: "app-installation",
        gitAuthor: { name: "Operator", email: "operator@example.test" },
      });
      expect(mocks.nativeToken).not.toHaveBeenCalled();
      expect(mocks.verify).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300_000);
      expect(await grant?.refresh?.()).toMatchObject({
        generation: 1,
        token: "synthetic-app-worker-2",
      });
      config.tools!.github.app.keyVersion = "replaced";
      expect(() => grant?.assertCurrent?.()).toThrow("changed");
    } finally {
      await grant?.revoke();
      vi.unstubAllGlobals();
    }
    expect(mocks.releaseProfile).toHaveBeenCalledTimes(3);
  });

  it("rejects a Factory credential lookup without current broker proof rather than issuing an App token", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    config = {};
    let brokerProof: ReturnType<typeof redeemFactoryGitHubProof> | undefined;
    let brokerToken: unknown;
    mocks.nativeToken.mockImplementation(async (_argv, options) => {
      const env = options.env;
      brokerToken = env.GH_TOKEN;
      brokerProof = redeemFactoryGitHubProof(env.OPENCLAW_FACTORY_GITHUB_PROOF);
      throw new Error("Factory broker proof refused");
    });
    const operator = createAdmittedRunOperatorAuthority({
      profileId: "operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    const error = await prepareWorkerGitHubBindingGrant({
      ...session,
      operatorAuthority: operator,
    }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message:
        "The selected GitHub identity could not be prepared; inspect the credential lookup error before retrying this turn.",
      cause: { message: "Factory broker proof refused" },
    });
    expect(mocks.nativeToken).toHaveBeenCalledOnce();
    expect(brokerToken).toBeUndefined();
    expect(brokerProof).toMatchObject({
      actorId: 101,
      profileId: "operator",
      purpose: "publication-preflight",
      binding: {
        kind: "session",
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        lifecycleRevision: null,
      },
    });
    expect(mocks.releaseProfile).toHaveBeenCalledTimes(2);
  });

  it.each(["managed", "enterprise", "non-GitHub"] as const)(
    "binds the verified %s account and its remote",
    async (kind) => {
      const enterprise = kind === "enterprise";
      const apiBaseUrl = enterprise ? "https://api.fixture.ghe.com" : "https://api.github.com";
      if (kind !== "managed") {
        config = enterprise ? { gateway: { github: { host: "fixture.ghe.com", apiBaseUrl } } } : {};
        setRuntimeConfigSnapshot(config);
        mocks.repository.mockResolvedValue({
          originUrl: enterprise
            ? "git@fixture.ghe.com:example/project.git"
            : "https://example.test/owner/repo.git",
        });
      } else {
        await installProfile();
      }
      await expect(prepareBinding(session)).resolves.toEqual({
        token,
        login: "shared-bot",
        branch: worktree.branch,
        ...(enterprise
          ? { host: "fixture.ghe.com", remoteUrl: "https://fixture.ghe.com/example/project.git" }
          : kind === "managed"
            ? { remoteUrl: "https://github.com/owner/repo.git", gitAuthor: { name: "Shared Bot" } }
            : {}),
      });
      expect(mocks.verify).toHaveBeenCalledWith(token, { apiBaseUrl });
      if (kind === "managed") {
        expect(mocks.nativeToken).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["system", "agent"] as const)(
    "retains the selected %s account through rotation and exact profile acknowledgment",
    async (scope) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      if (scope === "agent") {
        config.agents = {
          entries: { main: { tools: { github: { profileId, gitAuthor: { name: "Agent Bot" } } } } },
        };
      }
      const selectedConfig =
        scope === "agent" ? config.agents!.entries!.main!.tools!.github! : config.tools!.github!;
      selectedConfig.kind = "oauth";
      let expiresAtMs = Date.now() + 8 * 3_600_000;
      mocks.oauth.mockImplementation(() => ({
        state: "valid",
        record: {
          accountId: verified.account.accountId,
          accessExpiresAtMs: expiresAtMs,
        },
      }));
      const profileDir = await installProfile(scope);
      const grant = await prepareWorkerGitHubBindingGrant(session);
      try {
        expect(grant?.binding).toMatchObject({
          token,
          login: verified.account.login,
          gitAuthor: { name: scope === "agent" ? "Agent Bot" : "Shared Bot" },
        });
        expect(grant?.refresh).toBeTypeOf("function");
        expect(grant?.expiresAtMs).toBe(expiresAtMs);
        const started = Date.now();
        for (let step = 1; step <= 7; step++) {
          vi.setSystemTime(started + step * 8 * 3_600_000);
          expiresAtMs = Date.now() + 8 * 3_600_000;
          const rotated = `synthetic-selected-token-${step}`;
          await writeManagedGitHubProfileFiles(profileDir, {
            login: verified.account.login,
            token: rotated,
          });
          const next = await grant?.refresh?.();
          expect(next).toMatchObject({ generation: step, token: rotated, expiresAtMs });
          expect(grant?.binding.token).toBe(
            step === 1 ? token : `synthetic-selected-token-${step - 1}`,
          );
          expect(await grant?.refresh?.(step - 1)).toEqual(next);
          await grant?.refresh?.(step);
          expect(grant?.binding.token).toBe(rotated);
          const calls = mocks.refresh.mock.calls.length;
          expect(await grant?.refresh?.(step)).toBeUndefined();
          expect(mocks.refresh).toHaveBeenCalledTimes(calls);
        }
      } finally {
        await grant?.revoke();
      }
      expect(grant?.signal?.aborted).toBe(true);
      // Retiring execution must leave the account's canonical profile usable.
      expect((await prepareBinding(session))?.token).toBe("synthetic-selected-token-7");
    },
  );

  it("delivers profile rotations automatically, retries failed delivery, and joins delivery on cleanup", async () => {
    const profileDir = await installProfile();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const grant = await prepareWorkerGitHubBindingGrant(session);
    expect(grant).toBeDefined();
    const firstDelivery = createDeferredCore();
    const retryDelivery = createDeferredCore();
    const heldDelivery = createDeferredCore();
    const releaseDelivery = createDeferredCore();
    const followupDelivery = createDeferredCore();
    const releaseFollowup = createDeferredCore();
    const install = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstDelivery.resolve();
        throw new Error("synthetic transient transport failure");
      })
      .mockImplementationOnce(async () => {
        retryDelivery.resolve();
      })
      .mockImplementationOnce(async () => {
        heldDelivery.resolve();
        await releaseDelivery.promise;
      })
      .mockImplementationOnce(async () => {
        followupDelivery.resolve();
        await releaseFollowup.promise;
      });
    await writeManagedGitHubProfileFiles(profileDir, {
      login: verified.account.login,
      token: "synthetic-auto-token-1",
    });
    const stop = grant!.startRenewal!(install);
    try {
      await vi.advanceTimersByTimeAsync(1);
      await firstDelivery.promise;
      expect(grant!.binding.token).toBe(token);
      await vi.advanceTimersByTimeAsync(60_000);
      await retryDelivery.promise;
      // The consumer's completed installation acknowledges the exact pending generation.
      await vi.advanceTimersByTimeAsync(0);
      expect(install).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ generation: 1, token: "synthetic-auto-token-1" }),
      );
      expect(grant!.binding.token).toBe("synthetic-auto-token-1");
      await writeManagedGitHubProfileFiles(profileDir, {
        login: verified.account.login,
        token: "synthetic-auto-token-2",
      });
      await vi.advanceTimersByTimeAsync(1);
      await heldDelivery.promise;
      await writeManagedGitHubProfileFiles(profileDir, {
        login: verified.account.login,
        token: "synthetic-auto-token-3",
      });
      releaseDelivery.resolve();
      await followupDelivery.promise;
      expect(install).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ generation: 3, token: "synthetic-auto-token-3" }),
      );
      let settled = false;
      const cleanup = grant!.revoke().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(grant!.signal!.aborted).toBe(true);
      releaseFollowup.resolve();
      await cleanup;
      expect(settled).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(install).toHaveBeenCalledTimes(4);
    } finally {
      releaseDelivery.resolve();
      releaseFollowup.resolve();
      stop();
      await grant!.revoke();
    }
    expect((await prepareBinding(session))?.token).toBe("synthetic-auto-token-3");
  });

  it("keeps a profile rotation that arrives while credential verification is pending", async () => {
    const profileDir = await installProfile();
    vi.useFakeTimers({ toFake: ["Date"] });
    const grant = await prepareWorkerGitHubBindingGrant(session);
    const verifying = createDeferredCore();
    const verifiedRead = createDeferredCore();
    mocks.verify.mockImplementationOnce(async () => {
      verifying.resolve();
      await verifiedRead.promise;
      return verified;
    });
    try {
      vi.setSystemTime(Date.now() + 60_001);
      const refresh = grant!.refresh!();
      await verifying.promise;
      await writeManagedGitHubProfileFiles(profileDir, {
        login: verified.account.login,
        token: "synthetic-concurrent-rotation",
      });
      verifiedRead.resolve();
      await expect(refresh).resolves.toMatchObject({
        generation: 1,
        token: "synthetic-concurrent-rotation",
      });
    } finally {
      verifiedRead.resolve();
      await grant?.revoke();
    }
  });

  it("binds selected credentials for non-repository turns without checkout metadata or native fallback", async () => {
    mocks.session.mockReturnValue({
      canonicalKey: session.sessionKey,
      agentId: "main",
      entry: { sessionId: session.sessionId },
    });
    await expect(prepareWorkerGitHubBindingGrant(session)).rejects.toThrow(
      "selected GitHub identity is unavailable",
    );
    await installProfile();
    const grant = await prepareWorkerGitHubBindingGrant(session);
    try {
      expect(grant?.binding).toEqual({
        token,
        login: verified.account.login,
        gitAuthor: { name: "Shared Bot" },
      });
      expect(mocks.nativeToken).not.toHaveBeenCalled();
      expect(mocks.repository).not.toHaveBeenCalled();
      mocks.session.mockReturnValue({
        canonicalKey: session.sessionKey,
        agentId: "main",
        entry: { sessionId: "replacement-session" },
      });
      expect(() => grant?.assertCurrent?.()).toThrow();
      await expect(prepareWorkerGitHubBindingGrant(session)).rejects.toThrow();
    } finally {
      await grant?.revoke();
    }
  });

  it("uses selected Factory credentials for bounded repository reads without requiring a commit author", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("OPENCLAW_GITHUB_APP_ID", "13361");
    await installProfile();
    const identity = await prepareWorkerRepositoryGitHubIdentity({
      ...session,
      assertCurrent: () => {},
      readNativeCredential: async () => {
        throw new Error("Must not borrow native or personal account");
      },
    });
    expect(identity.token).toBe(token);
    expect(identity.selection).toMatchObject({ source: "system-configured", accountId: 42 });
    await identity.revalidate();
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.nativeToken).not.toHaveBeenCalled();
  });

  it("requires current Factory provenance even when a managed read account is configured", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    await installProfile();
    await expect(
      prepareWorkerRepositoryGitHubIdentity({ ...session, assertCurrent: () => {} }),
    ).rejects.toThrow("current Factory operator and session");
  });

  it.each(["current", "unredeemed", "closed"] as const)(
    "preserves a safe broker rejection through worker preparation with %s original authority",
    async (mode) => {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      config = {
        gateway: {
          github: { host: "microsoft.ghe.com", apiBaseUrl: "https://api.microsoft.ghe.com" },
        },
      };
      setRuntimeConfigSnapshot(config);
      let current = true;
      let proof: string | undefined;
      const diagnostic = {
        event: "github_credential_lookup_client",
        lookupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        stage: "broker",
        code: "http_rejected",
        httpStatus: 503,
      };
      mocks.nativeToken.mockImplementation(async (argv, options) => {
        expect(argv).toEqual(["gh", "auth", "token", "--hostname", "microsoft.ghe.com"]);
        expect(options.env.GH_HOST).toBe("microsoft.ghe.com");
        proof = options.env.OPENCLAW_FACTORY_GITHUB_PROOF;
        if (mode !== "unredeemed") {
          expect(redeemFactoryGitHubProof(proof!)).toMatchObject({
            actorId: 101,
            profileId: "operator",
            binding: { sessionId: session.sessionId, sessionKey: session.sessionKey },
          });
        }
        current = mode !== "closed";
        return {
          code: 1,
          termination: "exit",
          stdout: Buffer.from("synthetic-private-provider-body"),
          stderr: Buffer.from(`${JSON.stringify(diagnostic)}\n`),
        };
      });
      const operator = createAdmittedRunOperatorAuthority({
        profileId: "operator",
        scopes: ["operator.write"],
        assertCurrent: () => {
          if (!current) {
            throw new Error("Original authority closed");
          }
        },
      });
      const error = await prepareWorkerGitHubBindingGrant({
        ...session,
        operatorAuthority: operator,
      }).catch((failure: unknown) => failure);
      if (mode === "current") {
        expect(error).toMatchObject({
          name: "GitHubCredentialLookupError",
          diagnostic: {
            lookupId: diagnostic.lookupId,
            clientStage: "broker",
            clientCode: "http_rejected",
            httpStatus: 503,
          },
        });
        if (!(error instanceof Error)) {
          throw new Error("Worker preparation did not reject with an error");
        }
        expect(error.message).toContain("HTTP 503");
        expect(error.message).not.toMatch(/reconnect|token.*absent|repository_denied|403/i);
        expect(JSON.stringify(error)).not.toContain("synthetic-private-provider-body");
      } else {
        expect(error).not.toMatchObject({ name: "GitHubCredentialLookupError" });
        if (mode === "closed") {
          expect(error).toMatchObject({
            message: "Original authority closed",
          });
          expect(operator.assertCurrent).toThrow("Original authority closed");
        } else {
          expect(error).toMatchObject({
            message:
              "The selected GitHub identity could not be prepared; inspect the credential lookup error before retrying this turn.",
            cause: {
              message: "Factory GitHub broker did not authorize this credential lookup.",
              cause: {
                name: "GitHubCredentialLookupError",
                diagnostic: {
                  lookupId: diagnostic.lookupId,
                  clientStage: "broker",
                  clientCode: "http_rejected",
                  httpStatus: 503,
                },
              },
            },
          });
        }
      }
      expect(() => redeemFactoryGitHubProof(proof!)).toThrow();
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(mocks.repository).not.toHaveBeenCalled();
      expect(mocks.releaseProfile).toHaveBeenCalledTimes(2);
    },
  );

  it("retains the admitted Factory operator and exact session proof for native repository reads", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    config = {};
    let proof: ReturnType<typeof redeemFactoryGitHubProof> | undefined;
    mocks.nativeToken.mockImplementation(async (_argv, options) => {
      proof = redeemFactoryGitHubProof(options.env.OPENCLAW_FACTORY_GITHUB_PROOF);
      return { code: 0, stdout: Buffer.from(token), stderr: Buffer.alloc(0) };
    });
    const operator = createAdmittedRunOperatorAuthority({
      profileId: "operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    const identity = await prepareWorkerRepositoryGitHubIdentity({
      ...session,
      operatorAuthority: operator,
      assertCurrent: () => {},
    });
    expect(identity.token).toBe(token);
    expect(proof).toMatchObject({
      actorId: 101,
      profileId: "operator",
      binding: {
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        lifecycleRevision: null,
      },
    });
    expect(mocks.profile).toHaveBeenCalledExactlyOnceWith("operator");
    expect(mocks.profileFacts).toHaveBeenCalledWith(["operator-binding"]);
    expect(mocks.releaseProfile).toHaveBeenCalledOnce();
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(token, {
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("closes a retained selected-account grant immediately on configuration publication", async () => {
    let onConfigChanged: Parameters<typeof configModule.registerConfigWriteListener>[0] | undefined;
    const register = vi
      .spyOn(configModule, "registerConfigWriteListener")
      .mockImplementation((listener) => {
        onConfigChanged = listener;
        return () => {};
      });
    await installProfile();
    const grant = await prepareWorkerGitHubBindingGrant(session);
    try {
      config = { tools: { github: { profileId: "ghp_22222222222222222222222222222222" } } };
      onConfigChanged?.({
        configPath: "/fixture/openclaw.json",
        snapshot: createConfigFileSnapshot({
          path: "/fixture/openclaw.json",
          exists: true,
          raw: "{}",
          parsed: config,
          sourceConfig: config,
          valid: true,
          runtimeConfig: config,
          issues: [],
          warnings: [],
          legacyIssues: [],
        }),
        sourceConfig: config,
        runtimeConfig: config,
        persistedHash: "synthetic",
        revision: 2,
        fingerprint: "synthetic-next",
        sourceFingerprint: "synthetic-next",
        writtenAtMs: Date.now(),
      });
      expect(grant?.signal?.aborted).toBe(true);
    } finally {
      await grant?.revoke();
      register.mockRestore();
    }
  });

  it.each(["selection", "account", "turn"] as const)(
    "closes the execution credential after its %s authority changes",
    async (changed) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await installProfile();
      let current = true;
      const grant = await prepareWorkerGitHubBindingGrant({
        ...session,
        assertCurrent: () => current,
      });
      try {
        if (changed === "selection") {
          config = { tools: { github: { profileId: "ghp_22222222222222222222222222222222" } } };
        } else if (changed === "account") {
          mocks.verify.mockResolvedValue({
            ...verified,
            account: { ...verified.account, accountId: 99, login: "another-account" },
          });
        } else {
          current = false;
        }
        vi.setSystemTime(Date.now() + 60_001);
        await expect(grant?.refresh?.()).rejects.toThrow(
          /identity changed|account changed|authority closed/i,
        );
        expect(grant?.signal?.aborted).toBe(true);
      } finally {
        await grant?.revoke();
      }
    },
  );

  it("refuses a public managed identity when the selected execution host is enterprise", async () => {
    config.gateway = {
      github: { host: "fixture.ghe.com", apiBaseUrl: "https://api.fixture.ghe.com" },
    };
    setRuntimeConfigSnapshot(config);
    await installProfile();
    mocks.repository.mockResolvedValue({
      originUrl: "fixture@fixture.ghe.com:example/repo.git",
    });

    mocks.verify.mockClear();
    await expect(prepareBinding(session)).rejects.toThrow(
      "selected GitHub identity is unavailable",
    );
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("uses the agent override author without inheriting system author fields", async () => {
    config.agents = {
      entries: {
        main: { tools: { github: { profileId, gitAuthor: { email: "agent@example.test" } } } },
      },
    };
    await installProfile("agent");
    expect((await prepareBinding(session))?.gitAuthor).toEqual({
      email: "agent@example.test",
    });
  });

  it.each([{ name: "Shared\nBot" }, { email: "a".repeat(257) }])(
    "refuses launch-invalid author metadata before worker execution: %j",
    async (gitAuthor) => {
      config = { tools: { github: { profileId, gitAuthor } } };
      await installProfile();
      await expect(prepareBinding(session)).rejects.toThrow();
    },
  );

  it.each([
    ["missing-profile", prepareWorkerGitHubBindingGrant],
    ["missing-profile", prepareBinding],
    ["unavailable", prepareBinding],
  ] as const)(
    "refuses execution when the managed identity is %s (%#)",
    async (failure, prepare) => {
      if (failure !== "missing-profile") {
        await installProfile();
        mocks.verify.mockResolvedValue({ status: failure });
      }
      await expect(prepare(session)).rejects.toThrow(
        failure === "missing-profile" ? "selected GitHub identity is unavailable" : undefined,
      );
      expect(mocks.nativeToken).not.toHaveBeenCalled();
    },
  );

  it.each(["before-preparation", "verification", "repository", "identity", "worktree"] as const)(
    "rejects lost credential custody during %s",
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
        if (phase === "identity") {
          config = { tools: { github: { profileId: "ghp_22222222222222222222222222222222" } } };
        } else if (phase === "worktree") {
          mocks.worktree.mockReturnValue({ ...worktree, repoFingerprint: "replacement" });
        } else {
          current = false;
        }
        return { originUrl: "git@github.com:owner/repo.git" };
      });
      const operation = prepareBinding({ ...session, assertCurrent: () => current });
      if (phase === "before-preparation") {
        await expect(operation).resolves.toBeUndefined();
        expect(mocks.verify).not.toHaveBeenCalled();
      } else {
        await expect(operation).rejects.toThrow();
      }
    },
  );

  it("uses a refreshed profile on the next turn", async () => {
    const profileDir = await installProfile();
    const first = await prepareBinding(session);
    await fs.rm(profileDir, { recursive: true });
    const rotated = "synthetic-worker-github-rotated-token";
    await installManagedGitHubProfile({ profileDir, token: rotated, commitConfig: async () => {} });
    expect(first?.token).toBe(token);
    expect((await prepareBinding(session))?.token).toBe(rotated);
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
      const operation = prepareBinding({ ...session, assertCurrent: () => current });
      if (state === "current") {
        const binding = await operation;
        expect(binding).toMatchObject({
          token,
          branch: repository.branch,
          remoteUrl: repository.url,
        });
      } else {
        await expect(operation).rejects.toThrow();
      }
      expect(mocks.repository).not.toHaveBeenCalled();
      expect(mocks.worktree).not.toHaveBeenCalled();
    },
  );
});

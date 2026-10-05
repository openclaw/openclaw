import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { clearGitHubCredentialVerificationCache } from "../../agents/github-oauth-client.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { redeemFactoryGitHubProof } from "../factory-github-proof.js";
import { prepareWorkerTurnGitHub } from "./worker-github-binding.js";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  session: vi.fn(),
  workspace: vi.fn(),
  native: vi.fn(),
  probe: vi.fn(),
  managedToken: vi.fn(),
  oauth: vi.fn(),
  profile: vi.fn(),
}));
// mock-isolation: Keep native process/network and session reads synthetic while using real preparation owners.
vi.mock("../../process/exec.js", () => ({ runCommandBuffered: mocks.native }));
vi.mock("../../agents/github-managed-profile-read.js", () => ({
  readManagedGitHubToken: mocks.managedToken,
}));
vi.mock("../../agents/github-oauth-records.js", () => ({ inspectGitHubOAuthRecord: mocks.oauth }));
vi.mock("../github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: async () => {},
}));
vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: mocks.config,
}));
vi.mock("../session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: mocks.session }));
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async () => mocks.session(),
}));
vi.mock("../../state/session-repository-workspaces.js", () => ({
  getSessionRepositoryWorkspaceStore: () => ({
    prepare: async () => ({ workspace: mocks.workspace(), current: mocks.workspace }),
  }),
}));
vi.mock("../../state/user-profile-list.js", () => ({
  prepareUserProfileIdentity: mocks.profile,
  getUserProfileDisplay: () => ({ displayName: "Synthetic operator" }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const session = {
  agentId: "main",
  sessionId: "same-session",
  sessionKey: "agent:main:github-preparation",
};
const token = "synthetic-turn-native-token";
let config: OpenClawConfig;

beforeEach(() => {
  clearGitHubCredentialVerificationCache();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("worker-github-preparation-"));
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  config = {
    gateway: { github: { host: "microsoft.ghe.com", apiBaseUrl: "https://api.microsoft.ghe.com" } },
  };
  setRuntimeConfigSnapshot(config);
  mocks.config.mockReset().mockImplementation(() => ({ config, sourceConfig: config }));
  mocks.session.mockReset().mockImplementation(() => ({
    agentId: session.agentId,
    canonicalKey: session.sessionKey,
    entry: {
      sessionId: session.sessionId,
      lifecycleRevision: "same-lifecycle",
      repositoryWorkspaceId: "same-workspace",
    },
  }));
  mocks.workspace.mockReset().mockImplementation(() => ({
    workspaceId: "same-workspace",
    agentId: session.agentId,
    sessionKey: session.sessionKey,
    url: "https://microsoft.ghe.com/owner/repository.git",
    branch: "clawson/same-branch",
  }));
  mocks.profile.mockReset().mockImplementation(async () => ({
    emailBindingIds: ["same-binding"],
    readCurrentFacts: () => ({
      profile: { emails: ["github:microsoft.ghe.com:101", "actor@example.test"] },
    }),
    release: () => {},
  }));
  mocks.native.mockReset().mockImplementation(async (_argv, options) => {
    redeemFactoryGitHubProof(options.env.OPENCLAW_FACTORY_GITHUB_PROOF);
    return { code: 0, stdout: Buffer.from(token), stderr: Buffer.alloc(0) };
  });
  mocks.managedToken.mockReset().mockResolvedValue("synthetic-managed-execution-token");
  mocks.oauth.mockReset().mockReturnValue({ state: "missing" });
  mocks.probe.mockReset().mockImplementation(async (_url, options) => {
    const native = new Headers(options.headers).get("authorization")?.endsWith(token);
    return new Response(
      JSON.stringify({ id: native ? 101 : 202, login: native ? "native-actor" : "execution-bot" }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", mocks.probe);
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearGitHubCredentialVerificationCache();
});

it("prepares equivalent publication discovery and a fresh worker grant with one native lookup", async () => {
  const operator = createAdmittedRunOperatorAuthority({
    profileId: "operator",
    scopes: ["operator.write"],
    assertCurrent: () => {},
  });
  await withGatewayToolCallerIdentity({ ...session, operatorAuthority: operator }, async () => {
    const prepared = await prepareWorkerTurnGitHub({ ...session, operatorAuthority: operator });
    expect(prepared.githubPublicationAvailable).toBe(true);
    const grant = expectDefined(prepared.grant, "fresh grant");
    try {
      expect(grant.binding).toMatchObject({
        token,
        login: "native-actor",
        branch: "clawson/same-branch",
      });
      expect(mocks.native).toHaveBeenCalledOnce();
      expect(mocks.probe).toHaveBeenCalledOnce();
    } finally {
      await grant.revoke();
    }
  });
});

it.each(["native", "managed OAuth"] as const)(
  "reuses only verified facts for the second %s turn and creates a new grant",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    if (kind === "managed OAuth") {
      vi.stubEnv("FACTORY_AUTH_MODE", "");
      config = {
        tools: { github: { profileId: "ghp_11111111111111111111111111111111", kind: "oauth" } },
      };
      setRuntimeConfigSnapshot(config);
      mocks.workspace.mockImplementation(() => ({
        workspaceId: "same-workspace",
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        url: "https://github.com/owner/repository.git",
        branch: "clawson/same-branch",
      }));
      mocks.oauth.mockImplementation(() => ({
        state: "valid",
        record: {
          accountId: 202,
          refreshToken: "synthetic-refresh-token",
          accessExpiresAtMs: 601_000,
        },
      }));
    }
    const operator = createAdmittedRunOperatorAuthority({
      profileId: "operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    const params = { ...session, operatorAuthority: operator };
    const first = await prepareWorkerTurnGitHub(params);
    const oldGrant = expectDefined(first.grant, "first turn grant");
    await oldGrant.revoke();
    expect(() => oldGrant.assertCurrent?.()).toThrow("authority closed");
    vi.setSystemTime(kind === "managed OAuth" ? 91_000 : 2_000);
    const second = await prepareWorkerTurnGitHub(params);
    const newGrant = expectDefined(second.grant, "new turn grant");
    try {
      expect(newGrant).not.toBe(oldGrant);
      expect(second.githubPublicationAvailable).toBe(true);
      expect(newGrant.binding.branch).toBe("clawson/same-branch");
      expect(mocks.probe).toHaveBeenCalledOnce();
      expect(mocks.native).toHaveBeenCalledTimes(kind === "native" ? 2 : 0);
      newGrant.assertCurrent?.();
    } finally {
      await newGrant.revoke();
      vi.useRealTimers();
    }
  },
);

it("keeps configured Factory execution separate from publication discovery", async () => {
  config.tools = { github: { profileId: "ghp_11111111111111111111111111111111" } };
  const operator = createAdmittedRunOperatorAuthority({
    profileId: "operator",
    scopes: ["operator.write"],
    assertCurrent: () => {},
  });
  const prepared = await prepareWorkerTurnGitHub({ ...session, operatorAuthority: operator });
  const grant = expectDefined(prepared.grant, "managed execution grant");
  try {
    expect(grant.binding.login).toBe("execution-bot");
    expect(prepared.githubPublicationAvailable).toBe(false);
    expect(mocks.managedToken).toHaveBeenCalledTimes(2);
    expect(mocks.native).not.toHaveBeenCalled();
  } finally {
    await grant.revoke();
  }
});

it.each([
  "cancel",
  "issuer",
  "SID",
  "lifecycle",
  "workspace",
  "retirement",
  "host",
  "config",
] as const)("rejects %s change during the awaited native lookup", async (change) => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const abort = new AbortController();
  let current = true;
  const operator = createAdmittedRunOperatorAuthority({
    profileId: "operator",
    scopes: ["operator.write"],
    assertCurrent: () => {
      if (!current) {
        throw new Error("original issuer revoked");
      }
    },
  });
  const native = mocks.native.getMockImplementation();
  mocks.native.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return expectDefined(native, "native fixture")(...args);
  });
  const preparation = prepareWorkerTurnGitHub({
    ...session,
    operatorAuthority: operator,
    signal: abort.signal,
  });
  const outcome = preparation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await entered.promise;
  if (change === "cancel") {
    abort.abort();
  } else if (change === "issuer") {
    current = false;
  } else if (change === "host") {
    config.gateway = { github: { host: "other.ghe.com", apiBaseUrl: "https://api.other.ghe.com" } };
  } else if (change === "config") {
    config.tools = { github: { profileId: "ghp_22222222222222222222222222222222" } };
  } else if (change === "workspace") {
    mocks.workspace.mockReturnValue({
      workspaceId: "same-workspace",
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      url: "https://microsoft.ghe.com/owner/other.git",
      branch: "clawson/other",
    });
  } else if (change === "retirement") {
    mocks.workspace.mockReturnValue(undefined);
  } else {
    mocks.session.mockReturnValue({
      agentId: session.agentId,
      canonicalKey: session.sessionKey,
      entry: {
        sessionId: change === "SID" ? "other-session" : session.sessionId,
        lifecycleRevision: change === "lifecycle" ? "other-lifecycle" : "same-lifecycle",
        repositoryWorkspaceId: "same-workspace",
      },
    });
  }
  release.resolve();
  const result = await outcome;
  expect(result).toHaveProperty("error");
  if (change !== "config") {
    expect(mocks.probe).not.toHaveBeenCalled();
  }
});

import { vi } from "vitest";
import { WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  installManagedGitHubProfile,
  resolveManagedGitHubProfileDir,
} from "../../agents/github-tool-identity.js";
import * as turnClaims from "./placement-turn-claim-events.js";
import { bindWorkerGitHubTurn, prepareGitHubPublicationFact } from "./worker-github-binding.js";

type WorkerGitHubFixtureSession = { sessionId: string; sessionKey: string; agentId: string };

function createPreparedWorkerGitHubGrantFixture(session: WorkerGitHubFixtureSession) {
  return async function bindPreparedGrant(
    fact: Awaited<ReturnType<typeof prepareGitHubPublicationFact>>,
    assertCurrent = () => {},
    operatorAuthority?: AdmittedRunOperatorAuthority,
  ) {
    // Renewal tests isolate turn attachment; placement-owner tests cover admission.
    using attachment = vi.spyOn(turnClaims, "bindWorkerTurnGitHubGrant");
    attachment.mockImplementation(() => {});
    const grant = await bindWorkerGitHubTurn({
      session,
      operatorAuthority,
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
  };
}

export function createWorkerGitHubBindingFixture(params: {
  session: WorkerGitHubFixtureSession;
  profileId: string;
  token: string;
  resetVerification: () => void;
}) {
  const bindPreparedGrant = createPreparedWorkerGitHubGrantFixture(params.session);
  return {
    bindPreparedGrant,
    installProfile: async (scope: "agent" | "system" = "system") => {
      const profileDir = resolveManagedGitHubProfileDir({
        agentId: params.session.agentId,
        scope,
        profileId: params.profileId,
      });
      await installManagedGitHubProfile({
        profileDir,
        token: params.token,
        commitConfig: async () => {},
      });
      params.resetVerification();
      return profileDir;
    },
    prepareGrant: async (assertCurrent = () => {}, accessExpiresAtMs?: number) => {
      const fact = await prepareGitHubPublicationFact(params.session);
      if (!fact?.github || !fact.identity || !fact.workspaceKey) {
        throw new Error("Expected background identity");
      }
      params.resetVerification();
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
    },
  };
}

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

export const workerGitHubFixture = {
  profileId,
  token,
  sessionStorePath,
  session,
  sessionReadSource,
  worktree,
  verified,
};

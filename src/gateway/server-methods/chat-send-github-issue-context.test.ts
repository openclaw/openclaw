import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  ensureCanonicalFactoryGitHubProfile,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import {
  FACTORY_GITHUB_PROOF_ENV,
  factoryGitHubRequestDigest,
  redeemFactoryGitHubProof,
  type FactoryGitHubProofVerdict,
} from "../factory-github-proof.js";
import { rolePolicyConfig } from "../session-sharing.test-utils.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

const boundary = vi.hoisted(() => ({ native: vi.fn(), verify: vi.fn(), workspace: vi.fn() }));
vi.mock("../../agents/github-read-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/github-read-identity.js")>()),
  readNativeGitHubToken: boundary.native,
}));
vi.mock("../../agents/github-oauth-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/github-oauth-client.js")>()),
  verifyGitHubCredential: boundary.verify,
}));
vi.mock("../../state/session-repository-workspaces.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session-repository-workspaces.js")>()),
  getSessionRepositoryWorkspaceStore: () => ({
    get: boundary.workspace,
  }),
}));

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  boundary.native.mockReset();
  boundary.verify.mockReset();
  boundary.workspace.mockReset();
});

describe("registered Factory issue-context admission", () => {
  it.each(["actor-a", "actor-b", "actor-switched", "revoked", "session-replaced"] as const)(
    "keeps the admitted caller and session through issue reads: %s",
    async (scenario) => {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
      const fixture = await createFixture({ active: false });
      const actorId = scenario === "actor-b" ? 202 : 101;
      const profile = await ensureCanonicalFactoryGitHubProfile(
        `github:microsoft.ghe.com:${actorId}`,
        `Issue context actor ${actorId}`,
      );
      await setCanonicalUserProfileRole(profile.id, "write");
      fixture.client.authenticatedUserId = profile.id;
      fixture.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: profile.displayName,
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      };
      fixture.client.authenticatedFactoryGitHubAccountId = actorId;
      prepareGatewayRecipientProfile(fixture.client);
      const policyConfig = rolePolicyConfig();
      const config = {
        ...policyConfig,
        gateway: {
          ...policyConfig.gateway,
          projects: { nativeGitHubSearch: true },
          github: { host: "microsoft.ghe.com", apiBaseUrl: "https://api.microsoft.ghe.com" },
        },
        session: { store: fixture.scope.storePath },
      };
      setRuntimeConfigSnapshot(config);
      fixture.context.getRuntimeConfig = () => config;
      const issueUrl = "https://microsoft.ghe.com/example/project/issues/101";
      fixture.params.message = `Read ${issueUrl}`;
      await patchSessionEntryCore(fixture.scope, (entry) => ({
        ...entry,
        repositoryWorkspaceId: "issue-workspace",
      }));
      expect(loadSessionEntry(fixture.scope)?.repositoryWorkspaceId).toBe("issue-workspace");
      boundary.workspace.mockResolvedValue({
        agentId: "main",
        url: "https://microsoft.ghe.com/example/project.git",
      });
      const claims: FactoryGitHubProofVerdict[] = [];
      boundary.native.mockImplementation(async (env: NodeJS.ProcessEnv) => {
        const proof = env[FACTORY_GITHUB_PROOF_ENV];
        if (!proof) {
          throw new Error("Expected owner-issued Factory proof");
        }
        const claim = redeemFactoryGitHubProof(proof);
        claims.push(claim);
        return `synthetic-issue-token-${claim.actorId}`;
      });
      let verified = false;
      boundary.verify.mockImplementation(async () => {
        if (!verified) {
          verified = true;
          if (scenario === "actor-switched") {
            fixture.client.authenticatedFactoryGitHubAccountId = 202;
          }
          if (scenario === "revoked") {
            fixture.client.invalidated = true;
          }
          if (scenario === "session-replaced") {
            await replaceSessionEntry(fixture.scope, {
              ...loadSessionEntry(fixture.scope)!,
              sessionId: "replacement-session",
              lifecycleRevision: "replacement-generation",
            });
          }
        }
        return {
          status: "available",
          account: { accountId: actorId, login: `actor-${actorId}`, avatarUrl: null },
        };
      });
      const fetchIssue = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              title: "Issue context from the selected repository",
              body: "Synthetic issue",
              comments: 0,
              user: { login: "author" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      vi.stubGlobal("fetch", fetchIssue);
      try {
        const respond = await fixture.send(vi.fn(), {
          expectedProfileId: profile.id,
        });
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        await fixture.finishDispatch();
        expect(boundary.workspace).toHaveBeenCalledWith("issue-workspace");
        if (scenario === "actor-a" || scenario === "actor-b") {
          expect(fetchIssue).toHaveBeenCalledOnce();
          expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
          const delivered = dispatchInboundMessageMock.mock.calls[0]![0];
          expect(delivered).toMatchObject({
            ctx: {
              ChannelStructuredContext: expect.arrayContaining([
                expect.objectContaining({
                  type: "github_issue",
                  payload: expect.objectContaining({ number: 101 }),
                }),
              ]),
            },
          });
          expect(JSON.stringify(delivered)).not.toContain(`synthetic-issue-token-${actorId}`);
          expect(claims.length).toBeGreaterThan(0);
          for (const claim of claims) {
            expect(claim).toMatchObject({
              purpose: "session-issue-read",
              actorId,
              profileId: profile.id,
              binding: {
                agentId: fixture.scope.agentId,
                sessionKey: fixture.scope.sessionKey,
                sessionId: fixture.scope.sessionId,
                requestDigest: factoryGitHubRequestDigest(issueUrl),
              },
            });
          }
        } else {
          expect(fetchIssue).not.toHaveBeenCalled();
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          expect(claims[0]?.actorId).toBe(actorId);
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );
});

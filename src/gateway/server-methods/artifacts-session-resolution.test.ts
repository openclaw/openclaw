import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../session-sharing.test-utils.js";
import {
  ArtifactSessionResolutionError,
  resolveAuthorizedArtifactSession,
} from "./artifacts-session-resolution.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  getTaskSession: vi.fn(),
  resolveRunSession: vi.fn(),
}));

vi.mock("../../tasks/task-status-access.js", () => ({
  getTaskSessionLookupByIdForStatus: mocks.getTaskSession,
}));

vi.mock("../server-session-key.js", () => ({
  resolveSessionKeyForRun: mocks.resolveRunSession,
}));

function identifiedClient(scopes: string[], profileId = "viewer@example.com"): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
    authenticatedUserId: "viewer@example.com",
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

describe("artifact session authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies direct and indirect incognito selectors while preserving admin access", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dashboard:incognito-artifacts";
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-incognito-artifacts",
          updatedAt: 1,
          incognito: true,
          visibility: "shared",
        },
      );
      mocks.getTaskSession.mockReturnValue({
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        ownerKey: sessionKey,
      });
      mocks.resolveRunSession.mockReturnValue(sessionKey);
      const viewer = identifiedClient(["operator.read"]);

      expect(() =>
        resolveAuthorizedArtifactSession(
          { sessionKey: "dashboard:incognito-artifacts", agentId: "main" },
          cfg,
          viewer,
        ),
      ).toThrow('Incognito session "dashboard:incognito-artifacts" was not found.');
      for (const query of [{ taskId: "task-private" }, { runId: "run-private" }]) {
        try {
          resolveAuthorizedArtifactSession(query, cfg, viewer);
          throw new Error("expected incognito artifact selector to be denied");
        } catch (error) {
          expect(error).toBeInstanceOf(ArtifactSessionResolutionError);
          expect((error as ArtifactSessionResolutionError).shape).toMatchObject({
            message: "no session found for artifact query",
            details: { type: "artifact_scope_not_found" },
          });
        }
      }

      expect(
        resolveAuthorizedArtifactSession(
          { sessionKey: "dashboard:incognito-artifacts", agentId: "main" },
          cfg,
          identifiedClient(["operator.admin"]),
        ),
      ).toMatchObject({ sessionKey });
    });
  });

  it.each([
    { name: "draft without roles", visibility: "draft", cfg: {}, role: undefined },
    { name: "draft without runtime config", visibility: "draft", cfg: undefined, role: undefined },
    {
      name: "shared with a none role",
      visibility: "shared",
      cfg: rolePolicyConfig(),
      role: "none",
    },
    {
      name: "draft with a write role",
      visibility: "draft",
      cfg: rolePolicyConfig(),
      role: "write",
    },
  ] as const)(
    "hides $name artifacts behind direct, run, and task selectors",
    async ({ visibility, cfg, role }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const viewerProfile = ensureProfileForEmail("viewer@example.com");
        const ownerProfile = ensureProfileForEmail("owner@example.com");
        const sessionKey = "agent:main:foreign-artifacts";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "session-foreign-artifacts",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: ownerProfile.id },
            visibility,
          },
        );
        mocks.getTaskSession.mockImplementation((taskId: string) =>
          taskId === "task-run"
            ? { runId: "run-foreign", agentId: "main" }
            : {
                requesterSessionKey: sessionKey,
                requesterAgentId: "main",
                ownerKey: sessionKey,
              },
        );
        mocks.resolveRunSession.mockReturnValue(sessionKey);
        const viewer = role
          ? roleClient(role, "artifact-viewer")
          : identifiedClient(["operator.read"], viewerProfile.id);

        for (const query of [
          { sessionKey },
          { runId: "run-foreign" },
          { taskId: "task-foreign" },
          { taskId: "task-run" },
        ]) {
          expect(() => resolveAuthorizedArtifactSession(query, cfg, viewer)).toThrowError(
            expect.objectContaining({
              shape: {
                code: "INVALID_REQUEST",
                message: "no session found for artifact query",
                details: { type: "artifact_scope_not_found" },
              },
            }),
          );
        }

        expect(
          resolveAuthorizedArtifactSession(
            { sessionKey },
            cfg,
            identifiedClient(["operator.read"], ownerProfile.id),
          ),
        ).toMatchObject({ sessionKey });
        expect(
          resolveAuthorizedArtifactSession(
            { runId: "run-foreign" },
            cfg,
            identifiedClient(["operator.admin"], viewerProfile.id),
          ),
        ).toMatchObject({ sessionKey });
      });
    },
  );

  it.each(["shared", "read-only", "suggest"] as const)(
    "allows reading foreign %s artifacts without participation",
    async (visibility) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const owner = ensureProfileForEmail("artifact-owner@example.test");
        const viewer = roleClient("view", "artifact-reader");
        const sessionKey = "agent:main:readable-artifacts";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "session-readable-artifacts",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: owner.id },
            visibility,
          },
        );

        for (const cfg of [undefined, {}, rolePolicyConfig()]) {
          expect(resolveAuthorizedArtifactSession({ sessionKey }, cfg, viewer)).toMatchObject({
            sessionKey,
          });
        }
      });
    },
  );

  it("preserves solo and system reads while denying identityless reads with roles", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:solo-artifacts";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "session-solo-artifacts", updatedAt: 1, visibility: "draft" },
      );
      const identityless = sharingPolicyClient({});
      for (const client of [null, identityless, sharingPolicyClient({ user: "gateway-owner" })]) {
        expect(resolveAuthorizedArtifactSession({ sessionKey }, {}, client)).toMatchObject({
          sessionKey,
        });
      }
      const cfg = rolePolicyConfig();
      expect(() => resolveAuthorizedArtifactSession({ sessionKey }, cfg, identityless)).toThrow(
        "no session found for artifact query",
      );
      const system: GatewayClient = {
        ...identityless,
        internal: { operatorRoleActor: { kind: "system" } },
      };
      expect(resolveAuthorizedArtifactSession({ sessionKey }, cfg, system)).toMatchObject({
        sessionKey,
      });
    });
  });
});

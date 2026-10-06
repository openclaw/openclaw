import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import * as acpMetadata from "../acp/runtime/session-meta-readonly.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { assignSessionOwnerInWorker } from "../config/sessions/session-metadata-write.async.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const ensureProfileIdForEmail = vi.hoisted(() => vi.fn());
const prepareUserProfileRoleAuthority = vi.hoisted(() =>
  vi.fn(async (profileId: string) => ({ profileId, isCurrent: () => true })),
);
const getUserProfileDisplay = vi.hoisted(() =>
  vi.fn((profileId: string) => ({
    id: profileId,
    displayName: "Ada",
    avatarRevision: "1",
    hasAvatar: false,
  })),
);
const setCanonicalUserProfileDisplayName = vi.hoisted(() => vi.fn());

vi.mock("../state/user-profile-email.js", () => ({ ensureProfileIdForEmail }));
vi.mock("../state/user-channel-identity-operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-channel-identity-operations.js")>()),
  prepareUserProfileRoleAuthority,
}));

vi.mock("../state/user-profile-writes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-writes.js")>()),
  setCanonicalUserProfileDisplayName,
}));

vi.mock("../state/user-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profiles.js")>()),
  getUserProfileDisplay,
  getUserProfileListItem: vi.fn(),
  UserProfileNotFoundError: class UserProfileNotFoundError extends Error {},
}));

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  ensureProfileIdForEmail.mockReset();
  prepareUserProfileRoleAuthority.mockClear();
  getUserProfileDisplay.mockClear();
  setCanonicalUserProfileDisplayName.mockReset();
});

describe("gateway method authorization", () => {
  async function dispatchProfileMutation(params: {
    authenticatedUserId?: string;
    profileId: string;
    scopes: string[];
  }) {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "req-users-1",
        method: "users.setDisplayName",
        params: { displayName: "Ada", profileId: params.profileId },
      },
      respond,
      client: {
        connId: "conn-users-1",
        ...(params.authenticatedUserId ? { authenticatedUserId: params.authenticatedUserId } : {}),
        connect: {
          role: "operator",
          scopes: params.scopes,
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
    });
    return respond;
  }

  it("admits write-scoped requests for handler-level self-service authorization", async () => {
    const respond = await dispatchProfileMutation({
      profileId: "profile-1",
      scopes: ["operator.write"],
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("rejects profile mutations before the handler without write scope", async () => {
    const respond = await dispatchProfileMutation({
      profileId: "profile-1",
      scopes: ["operator.read"],
    });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: "missing scope: operator.write",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.write",
        requiredScopes: ["operator.write"],
      },
    });
  });

  it("allows an identified write caller to edit its own profile", async () => {
    const profile = { id: "profile-1" };
    ensureProfileIdForEmail.mockResolvedValue(profile.id);
    setCanonicalUserProfileDisplayName.mockResolvedValue({ profile });

    expect(
      await dispatchProfileMutation({
        authenticatedUserId: "ada@example.com",
        profileId: "profile-1",
        scopes: ["operator.write"],
      }),
    ).toHaveBeenCalledWith(true, { profile });
  });

  it("requires admin when an identified write caller targets another profile", async () => {
    ensureProfileIdForEmail.mockResolvedValue("profile-1");

    expect(
      await dispatchProfileMutation({
        authenticatedUserId: "ada@example.com",
        profileId: "profile-2",
        scopes: ["operator.write"],
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("allows an admin caller to edit any profile", async () => {
    const profile = { id: "profile-2" };
    setCanonicalUserProfileDisplayName.mockResolvedValue({ profile });

    expect(
      await dispatchProfileMutation({
        profileId: "profile-2",
        scopes: ["operator.admin"],
      }),
    ).toHaveBeenCalledWith(true, { profile });
  });

  it.each([
    { phase: "before commit", change: "replacement" },
    { phase: "before response", change: "replacement" },
    { phase: "before response", change: "reassignment" },
  ] as const)("rejects a session $change $phase", async ({ phase, change }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:commit-bound-authorization";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-shared",
          updatedAt: 1,
          visibility: "shared",
        },
      );

      const handlerCanContinue = createDeferredCore();
      const handlerStarted = createDeferredCore();
      const patchHandler = sessionMutationHandlers["sessions.patch"];
      if (!patchHandler) {
        throw new Error("sessions.patch handler is not registered");
      }
      const readMetadata = acpMetadata.readAcpSessionMetaForEntries;
      const metadataRead =
        phase === "before response"
          ? vi
              .spyOn(acpMetadata, "readAcpSessionMetaForEntries")
              .mockImplementation(async (params) => {
                const result = await readMetadata(params);
                if (
                  params.entries.some((entry) => entry.sessionKey === sessionKey) &&
                  loadSessionEntry({ agentId: "main", sessionKey })?.label === "stale mutation"
                ) {
                  handlerStarted.resolve();
                  await handlerCanContinue.promise;
                }
                return result;
              })
          : undefined;
      const respond = vi.fn();
      const request = handleGatewayRequest({
        req: {
          type: "req",
          id: "req-session-commit-bound",
          method: "sessions.patch",
          params: { key: sessionKey, label: "stale mutation" },
        },
        respond,
        client: {
          connId: "conn-session-commit-bound",
          authenticatedUserId: "member@example.com",
          authenticatedUserProfile: {
            profileId: "member",
            displayName: "Member",
            hasAvatar: false,
            updatedAt: 1,
          },
          connect: {
            role: "operator",
            scopes: ["operator.write"],
            client: { id: "test", version: "1", platform: "test", mode: "test" },
            minProtocol: 1,
            maxProtocol: 1,
          },
        } as Parameters<typeof handleGatewayRequest>[0]["client"],
        isWebchatConnect: () => false,
        context: {
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
          broadcast: vi.fn(),
          broadcastToConnIds: vi.fn(),
          getSessionEventSubscriberConnIds: () => new Set(),
          chatAbortControllers: new Map(),
        } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
        extraHandlers: {
          "sessions.patch": async (options) => {
            if (phase === "before commit") {
              handlerStarted.resolve();
              await handlerCanContinue.promise;
            }
            await patchHandler(options);
          },
        },
      });

      try {
        await awaitGateBeforeSettlement(
          handlerStarted.promise,
          request,
          `Session patch settled before ${phase} barrier`,
        );
        expect(respond).not.toHaveBeenCalled();
        const before = loadSessionEntry({ agentId: "main", sessionKey });
        if (phase === "before response") {
          expect(before?.label).toBe("stale mutation");
        } else {
          expect(before).not.toHaveProperty("label");
        }
        const sessionId = change === "replacement" ? "session-draft-replacement" : "session-shared";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt: 2,
            ...(phase === "before response" ? { label: "current owner label" } : {}),
            visibility: "draft",
            createdVia: "operator",
            createdActor: { type: "human", source: "profile", id: "owner" },
          },
        );
        await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
          visibility: "draft",
        }));
        if (change === "reassignment") {
          await assignSessionOwnerInWorker(
            { agentId: "main", sessionKey },
            {
              owner: { type: "human", id: "owner" },
              assignedBy: { type: "system", id: "fixture" },
              assignedAt: 2,
              expectedSessionId: sessionId,
            },
          );
        }
        handlerCanContinue.resolve();
        await request;

        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            details: expect.objectContaining({
              code:
                change === "reassignment"
                  ? "SESSION_PARTICIPATION_REQUIRED"
                  : "SESSION_MUTATION_AUTHORIZATION_CHANGED",
            }),
          }),
        );
        expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
          sessionId,
          visibility: "draft",
        });
        const current = loadSessionEntry({ agentId: "main", sessionKey });
        if (phase === "before response") {
          expect(current?.label).toBe("current owner label");
          if (change === "reassignment") {
            expect(current?.owner?.actor).toEqual({ type: "human", id: "owner" });
          }
        } else {
          expect(current).not.toHaveProperty("label");
        }
      } finally {
        handlerCanContinue.resolve();
        await Promise.allSettled([request]);
        metadataRead?.mockRestore();
      }
    });
  });

  it("authorizes lifecycle targets from each method's protocol shape", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:lifecycle-authorization-target";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-lifecycle-authorization-target",
          updatedAt: 1,
          visibility: "read-only",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "owner" },
        },
      );

      const dispatchRequest = async (
        method:
          | "sessions.create"
          | "sessions.fork"
          | "sessions.github.publish"
          | "sessions.recover",
        requestParams: Record<string, unknown>,
        profileId: string,
      ) => {
        const handler = vi.fn<GatewayRequestHandler>(({ respond, sessionMutationAuthorization }) =>
          respond(true, { authorized: sessionMutationAuthorization !== undefined }),
        );
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: `${method}-${profileId}`, method, params: requestParams },
          respond,
          client: {
            connId: `${method}-${profileId}`,
            authenticatedUserId: `${profileId}@example.com`,
            authenticatedUserProfile: {
              profileId,
              displayName: profileId,
              hasAvatar: false,
              updatedAt: 1,
            },
            connect: {
              role: "operator",
              scopes: ["operator.write"],
              client: { id: "test", version: "1", platform: "test", mode: "test" },
              minProtocol: 1,
              maxProtocol: 1,
            },
          } as Parameters<typeof handleGatewayRequest>[0]["client"],
          isWebchatConnect: () => false,
          context: {
            chatAbortControllers: new Map(),
            getRuntimeConfig: () => ({}),
            logGateway: { warn: vi.fn() },
          } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
          extraHandlers: { [method]: handler },
        });
        return { handler, respond };
      };

      const cases = [
        {
          method: "sessions.create" as const,
          params: { parentSessionKey: sessionKey, fork: true },
        },
        {
          method: "sessions.fork" as const,
          params: { sessionKey, entryId: "user-entry" },
        },
        {
          method: "sessions.github.publish" as const,
          params: { sessionKey, idempotencyKey: "publication-1" },
        },
        { method: "sessions.recover" as const, params: { key: sessionKey } },
      ];
      for (const testCase of cases) {
        const owner = await dispatchRequest(testCase.method, testCase.params, "owner");
        expect(owner.handler, testCase.method).toHaveBeenCalledOnce();
        expect(owner.respond, testCase.method).toHaveBeenCalledWith(true, { authorized: true });

        const outsider = await dispatchRequest(testCase.method, testCase.params, "outsider");
        expect(outsider.handler, testCase.method).not.toHaveBeenCalled();
        expect(outsider.respond, testCase.method).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
          }),
        );
      }
    });
  });
});

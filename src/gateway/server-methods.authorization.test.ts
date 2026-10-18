import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import * as acpMetadata from "../acp/runtime/session-meta-readonly.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { assignSessionOwnerInWorker } from "../config/sessions/session-metadata-write.async.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import type * as UserProfileEmail from "../state/user-profile-email.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  authorizationClient as clientFor,
  startAuthorizationRequest as dispatch,
} from "./server-methods.authorization.test-support.js";
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

vi.mock("../state/user-profile-email.js", async (importOriginal) => ({
  ...(await importOriginal<typeof UserProfileEmail>()),
  ensureProfileIdForEmail,
}));
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

function identifiedClient(profileId: string) {
  return clientFor(`conn-${profileId}`, ["operator.write"], {
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: { profileId, displayName: profileId, hasAvatar: false, updatedAt: 1 },
  });
}

function expectForbidden(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
}

describe("gateway method authorization", () => {
  it.each(["operator.read", "operator.write", "operator.admin"])(
    "requires admin authority for installed-runtime setup (%s)",
    async (scope) => {
      const handler = vi.fn<GatewayRequestHandler>(({ respond: reply }) => reply(true, {}));
      const { request, respond } = dispatch(
        "openclaw.setup.runtime.start",
        {
          sessionId: "runtime-consent",
          agentId: "research",
          runtimeId: "fixture-native",
          configPatch: { plugins: { entries: { fixture: { config: { enabled: true } } } } },
        },
        {
          client: clientFor("runtime-operator", [scope]),
          extraHandlers: { "openclaw.setup.runtime.start": handler },
        },
      );
      await request;
      if (scope === "operator.admin") {
        expect(handler).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(true, {});
      } else {
        expect(handler).not.toHaveBeenCalled();
        expectForbidden(respond);
      }
    },
  );

  it.each([
    ["unidentified write caller", "operator.write", false, "profile-1", false],
    ["identified self-service caller", "operator.write", true, "profile-1", true],
    ["identified non-owner", "operator.write", true, "profile-2", false],
    ["admin caller", "operator.admin", false, "profile-2", true],
  ] as const)(
    "authorizes profile edits for %s",
    async (_name, scope, identified, target, allowed) => {
      const profile = { id: target };
      if (identified) {
        ensureProfileIdForEmail.mockResolvedValue("profile-1");
      }
      if (allowed) {
        setCanonicalUserProfileDisplayName.mockResolvedValue({ profile });
      }
      const { request, respond } = dispatch(
        "users.setDisplayName",
        { displayName: "Ada", profileId: target },
        {
          client: clientFor(
            "conn-users-1",
            [scope],
            identified ? { authenticatedUserId: "ada@example.com" } : {},
          ),
        },
      );
      await request;
      if (allowed) {
        expect(respond).toHaveBeenCalledWith(true, { profile });
      } else {
        expectForbidden(respond);
      }
    },
  );

  it.each([
    { phase: "before commit", change: "replacement" },
    { phase: "before response", change: "replacement" },
    { phase: "before response", change: "reassignment" },
  ] as const)("rejects a session $change $phase", async ({ phase, change }) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot({});
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
      const { request, respond } = dispatch(
        "sessions.patch",
        { key: sessionKey, label: "stale mutation" },
        {
          client: identifiedClient("member"),
          context: {
            broadcast: vi.fn(),
            broadcastToConnIds: vi.fn(),
            getSessionEventSubscriberConnIds: () => new Set(),
            chatAbortControllers: new Map(),
          },
          extraHandlers: {
            "sessions.patch": async (options) => {
              if (phase === "before commit") {
                handlerStarted.resolve();
                await handlerCanContinue.promise;
              }
              await patchHandler(options);
            },
          },
        },
      );

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
        const current = loadSessionEntry({ agentId: "main", sessionKey });
        expect(current).toMatchObject({
          sessionId,
          visibility: "draft",
          ...(phase === "before response" ? { label: "current owner label" } : {}),
        });
        if (change === "reassignment") {
          expect(current?.owner?.actor).toEqual({ type: "human", id: "owner" });
        }
        if (phase === "before commit") {
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
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot({});
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

      const cases = [
        ["sessions.create", { parentSessionKey: sessionKey, fork: true }],
        ["sessions.fork", { sessionKey, entryId: "user-entry" }],
        ["sessions.github.publish", { sessionKey, idempotencyKey: "publication-1" }],
        ["sessions.recover", { key: sessionKey }],
      ] as const;
      const dispatchRequest = async (
        method: (typeof cases)[number][0],
        requestParams: Record<string, unknown>,
        profileId: string,
      ) => {
        const handler = vi.fn<GatewayRequestHandler>(({ respond, sessionMutationAuthorization }) =>
          respond(true, { authorized: sessionMutationAuthorization !== undefined }),
        );
        const { request, respond } = dispatch(method, requestParams, {
          client: identifiedClient(profileId),
          context: { chatAbortControllers: new Map() },
          extraHandlers: { [method]: handler },
        });
        await request;
        return { handler, respond };
      };

      for (const [method, params] of cases) {
        const owner = await dispatchRequest(method, params, "owner");
        expect(owner.handler, method).toHaveBeenCalledOnce();
        expect(owner.respond, method).toHaveBeenCalledWith(true, { authorized: true });

        const outsider = await dispatchRequest(method, params, "outsider");
        expect(outsider.handler, method).not.toHaveBeenCalled();
        expect(outsider.respond, method).toHaveBeenCalledWith(
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

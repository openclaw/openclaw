import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntry,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  listSessionMembers,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createBoardViewTicket } from "../board-view-ticket.js";
import {
  authorizeResolvedSessionMutation,
  authorizeSessionMutation,
  canReceiveSessionEvent,
  filterDraftSessionsForClient,
  invalidateSessionSharingSnapshot,
} from "../session-sharing.js";
import { sessionReadHandlers } from "./sessions-read.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type ResolveSessionSharingTarget =
  (typeof import("../session-sharing.js"))["resolveSessionSharingTarget"];

const targetResolutionMock = vi.hoisted(() => ({
  calls: 0,
  override: undefined as
    | undefined
    | ((
        target: ReturnType<ResolveSessionSharingTarget>,
        call: number,
      ) => ReturnType<ResolveSessionSharingTarget>),
}));

vi.mock("../session-sharing.js", async () => {
  const actual =
    await vi.importActual<typeof import("../session-sharing.js")>("../session-sharing.js");
  return {
    ...actual,
    resolveSessionSharingTarget: (params: Parameters<ResolveSessionSharingTarget>[0]) => {
      const target = actual.resolveSessionSharingTarget(params);
      const call = ++targetResolutionMock.calls;
      return targetResolutionMock.override?.(target, call) ?? target;
    },
  };
});

afterEach(() => {
  targetResolutionMock.calls = 0;
  targetResolutionMock.override = undefined;
  closeOpenClawAgentDatabasesForTest();
});

function soloClient(): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
  };
}

function identifiedClient(profileId: string): GatewayClient {
  return {
    ...soloClient(),
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

function context(broadcast: ReturnType<typeof vi.fn>): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    broadcast,
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

async function call(
  method: "session.visibility.set" | "session.members.list" | "session.members.add",
  params: Record<string, unknown>,
  requestContext: GatewayRequestContext,
  requestClient: GatewayClient = soloClient(),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionSharingHandlers[method]?.({
    params,
    client: requestClient,
    context: requestContext,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses;
}

describe("session sharing handlers", () => {
  it("rejects a visibility mutation when the queued session instance changed", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:stale-sharing-mutation";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-authorized",
          updatedAt: 1,
          visibility: "shared",
        },
      );
      targetResolutionMock.override = (target, call) =>
        call === 2 && target
          ? {
              ...target,
              entry: { ...target.entry, sessionId: "session-replaced" },
            }
          : target;
      const broadcast = vi.fn();
      const respond = vi.fn();

      await expect(
        sessionSharingHandlers["session.visibility.set"]?.({
          params: { sessionKey, visibility: "draft" },
          client: soloClient(),
          context: context(broadcast),
          respond,
        } as never),
      ).rejects.toThrow("session changed before sharing mutation");

      expect(loadSessionEntry({ agentId: "main", sessionKey })?.visibility).toBe("shared");
      expect(respond).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalledWith(
        "session.sharing",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it("authorizes runs against the resolved session so keyless runs cannot bypass restriction", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:main";
      const owner = { id: "owner@example.com", label: "Owner" };
      const outsider: GatewayClient = { ...soloClient(), operatorIdentity: { id: "outsider" } };
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId: "session-main", updatedAt: 1, createdBy: owner, visibility: "read-only" },
      );

      // The agent-run handler authorizes this resolved (default/effective) key
      // even when the request omitted sessionKey; a non-participant is blocked.
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: outsider,
          sessionKey,
          agentId: "main",
        }),
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      // The owner, and a not-yet-created session, both pass.
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: { ...soloClient(), operatorIdentity: owner },
          sessionKey,
          agentId: "main",
        }),
      ).toBeNull();
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: outsider,
          sessionKey: "agent:main:fresh",
          agentId: "main",
        }),
      ).toBeNull();
    });
  });

  it("projects a shared session member's truthful role in sessions.list", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:shared-member";
      const memberIdentity = { id: "member@example.com", label: "Member" };
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-shared-member",
          updatedAt: 1,
          createdBy: { id: "owner@example.com" },
          visibility: "shared",
        },
      );
      expect(
        addSessionMember(
          { agentId: "main", sessionKey },
          { identityId: memberIdentity.id, addedBy: "owner@example.com", addedAt: 1 },
        ).inserted,
      ).toBe(true);
      const responses: Parameters<RespondFn>[] = [];
      await sessionReadHandlers["sessions.list"]?.({
        params: { agentId: "main" },
        client: { ...soloClient(), operatorIdentity: memberIdentity },
        context: {
          ...context(vi.fn()),
          loadGatewayModelCatalog: async () => [],
        } as unknown as GatewayRequestContext,
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);

      expect(responses[0]?.[0]).toBe(true);
      const payload = responses[0]?.[1] as
        | { sessions?: Array<{ key: string; sharingRole?: string }> }
        | undefined;
      expect(payload?.sessions?.find((session) => session.key === sessionKey)?.sharingRole).toBe(
        "member",
      );
    });
  });

  it("authorizes board tickets against their signed agent-relative session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey: "global" },
        { sessionId: "session-main-global", updatedAt: 1, visibility: "shared" },
      );
      await upsertSessionEntry(
        { agentId: "work", sessionKey: "global" },
        {
          sessionId: "session-work-global",
          updatedAt: 1,
          visibility: "read-only",
          createdBy: { id: "owner@example.com" },
        },
      );
      const { ticket } = createBoardViewTicket({
        sessionKey: "global",
        agentId: "work",
        name: "status",
        revision: 1,
        viewGeneration: "a".repeat(32),
      });
      const memberClient: GatewayClient = {
        ...soloClient(),
        operatorIdentity: { id: "outsider@example.com" },
      };
      const requestContext = context(vi.fn());
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      } as never;

      expect(
        authorizeSessionMutation({
          cfg,
          client: memberClient,
          method: "board.action",
          requestParams: { ticket, agentId: "work" },
          context: requestContext,
        }),
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });

      const { ticket: unscopedTicket } = createBoardViewTicket({
        sessionKey: "global",
        name: "status",
        revision: 1,
        viewGeneration: "b".repeat(32),
      });
      expect(
        authorizeSessionMutation({
          cfg,
          client: memberClient,
          method: "board.action",
          requestParams: { ticket: unscopedTicket, agentId: "work" },
          context: requestContext,
        }),
      ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
    });
  });

  it("revokes all member access while a session is draft and restores it when shared", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:member-transition";
      const owner = { id: "owner@example.com", label: "Owner" };
      const memberIdentity = { id: "member@example.com", label: "Member" };
      const memberClient: GatewayClient = {
        ...soloClient(),
        operatorIdentity: memberIdentity,
      };
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-member-transition",
          updatedAt: 1,
          createdBy: owner,
          visibility: "shared",
        },
      );
      expect(
        addSessionMember(
          { agentId: "main", sessionKey },
          { identityId: memberIdentity.id, addedBy: owner.id, addedAt: 1 },
        ).inserted,
      ).toBe(true);
      const requestContext = {
        ...context(vi.fn()),
        execApprovalManager: {
          lookupApprovalId: () => ({ kind: "exact", id: "approval-1" }),
          getSnapshot: () => ({ request: { sessionKey, agentId: "main" } }),
        },
      } as unknown as GatewayRequestContext;
      const mutations: Array<[string, Record<string, unknown>]> = [
        ["chat.send", { sessionKey }],
        ["sessions.steer", { key: sessionKey }],
        ["sessions.abort", { key: sessionKey }],
        ["exec.approval.resolve", { id: "approval-1" }],
      ];
      const expectAccess = (allowed: boolean) => {
        for (const [method, requestParams] of mutations) {
          const error = authorizeSessionMutation({
            cfg: {},
            client: memberClient,
            method,
            requestParams,
            context: requestContext,
          });
          if (allowed) {
            expect(error, method).toBeNull();
          } else {
            expect(error, method).toMatchObject({
              details: { code: "SESSION_PARTICIPATION_REQUIRED" },
            });
          }
        }
        const entry = loadSessionEntry({ agentId: "main", sessionKey });
        if (!entry) {
          throw new Error("expected member transition session entry");
        }
        const listed = filterDraftSessionsForClient({
          client: memberClient,
          store: { [sessionKey]: entry },
        });
        expect(Object.hasOwn(listed, sessionKey)).toBe(allowed);
        expect(
          canReceiveSessionEvent({
            cfg: {},
            client: memberClient as never,
            sessionKeys: [sessionKey],
            agentId: "main",
          }),
        ).toBe(allowed);
      };

      expectAccess(true);
      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "draft" }));
      invalidateSessionSharingSnapshot(sessionKey);
      expectAccess(false);
      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "shared" }));
      invalidateSessionSharingSnapshot(sessionKey);
      expectAccess(true);
    });
  });

  it("persists visibility and membership changes as transcript system notes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:main";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId: "session-main", updatedAt: 1 },
      );
      const broadcast = vi.fn();
      const requestContext = context(broadcast);

      expect(
        await call(
          "session.visibility.set",
          { sessionKey, visibility: "read-only" },
          requestContext,
        ),
      ).toEqual([[true, { ok: true, sessionKey, visibility: "read-only" }, undefined]]);
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.visibility).toBe("read-only");

      expect(
        await call(
          "session.members.add",
          { sessionKey, identityId: "local-operator" },
          requestContext,
        ),
      ).toEqual([[true, { ok: true, sessionKey, identityId: "local-operator" }, undefined]]);
      expect(listSessionMembers({ agentId: "main", sessionKey })).toEqual([
        expect.objectContaining({ identityId: "local-operator", addedBy: "local-operator" }),
      ]);

      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId: "session-main",
        sessionKey,
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              customType: "openclaw.system-note",
              content: expect.stringContaining("changed session visibility"),
            }),
          }),
          expect.objectContaining({
            message: expect.objectContaining({
              customType: "openclaw.system-note",
              content: expect.stringContaining("added local-operator"),
            }),
          }),
        ]),
      );
      expect(broadcast).toHaveBeenCalledWith(
        "session.sharing",
        expect.objectContaining({ sessionKey }),
        { sessionKeys: [sessionKey] },
      );

      const restrictedKey = "agent:main:restricted";
      await upsertSessionEntry(
        { agentId: "main", sessionKey: restrictedKey },
        {
          sessionId: "session-restricted",
          updatedAt: 2,
          visibility: "read-only",
          category: "Projects",
        },
      );
      expect(
        authorizeSessionMutation({
          cfg: {},
          client: identifiedClient("viewer"),
          method: "sessions.groups.delete",
          requestParams: { name: "Projects" },
          context: requestContext,
        }),
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      expect(
        await call("session.members.list", { sessionKey: restrictedKey }, requestContext, {
          ...identifiedClient("viewer"),
        }),
      ).toEqual([
        [
          false,
          undefined,
          expect.objectContaining({
            details: expect.objectContaining({ code: "SESSION_SHARING_MANAGER_REQUIRED" }),
          }),
        ],
      ]);

      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "shared" }));
      invalidateSessionSharingSnapshot();
      const viewerClient = identifiedClient("viewer") as never;
      expect(
        canReceiveSessionEvent({
          cfg: {},
          client: viewerClient,
          sessionKeys: ["main"],
          agentId: "main",
        }),
      ).toBe(true);
      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "draft" }));
      invalidateSessionSharingSnapshot(sessionKey);
      expect(
        canReceiveSessionEvent({
          cfg: {},
          client: viewerClient,
          sessionKeys: ["main"],
          agentId: "main",
        }),
      ).toBe(false);

      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "shared" }));
      const append = vi
        .spyOn(SessionManager.prototype, "appendMessage")
        .mockImplementationOnce(() => {
          throw new Error("audit unavailable");
        });
      const concurrent = await Promise.allSettled([
        call("session.visibility.set", { sessionKey, visibility: "read-only" }, requestContext),
        call("session.visibility.set", { sessionKey, visibility: "draft" }, requestContext),
      ]);
      append.mockRestore();
      expect(concurrent.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.visibility).toBe("draft");

      removeSessionMember({ agentId: "main", sessionKey }, "local-operator");
      const memberAppend = vi
        .spyOn(SessionManager.prototype, "appendMessage")
        .mockImplementationOnce(() => {
          throw new Error("audit unavailable");
        });
      const concurrentAdds = await Promise.allSettled([
        call("session.members.add", { sessionKey, identityId: "local-operator" }, requestContext),
        call("session.members.add", { sessionKey, identityId: "local-operator" }, requestContext),
      ]);
      memberAppend.mockRestore();
      expect(concurrentAdds.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
      expect(listSessionMembers({ agentId: "main", sessionKey })).toEqual([
        expect.objectContaining({ identityId: "local-operator" }),
      ]);
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntry,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  listSessionMembers,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  authorizeSessionMutation,
  canReceiveSessionEvent,
  invalidateSessionSharingSnapshot,
} from "../session-sharing.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

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
          client: { ...soloClient(), authenticatedUserId: "viewer" },
          method: "sessions.groups.delete",
          requestParams: { name: "Projects" },
          context: requestContext,
        }),
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      expect(
        await call("session.members.list", { sessionKey: restrictedKey }, requestContext, {
          ...soloClient(),
          authenticatedUserId: "viewer",
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
      const viewerClient = {
        ...soloClient(),
        authenticatedUserId: "viewer",
      } as never;
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

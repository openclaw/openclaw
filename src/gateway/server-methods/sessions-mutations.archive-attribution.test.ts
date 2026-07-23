import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function client(profileId?: string, displayName?: string): GatewayClient {
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
    ...(profileId
      ? {
          authenticatedUserId: `${profileId}@example.com`,
          authenticatedUserProfile: {
            profileId,
            displayName: displayName ?? null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

function context(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    loadGatewayModelCatalog: vi.fn(async () => []),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

async function patchSession(
  params: { key: string; archived: boolean; label?: string },
  requestClient: GatewayClient,
) {
  const responses = await invokePatchSession(params, requestClient);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
}

async function invokePatchSession(
  params: { key: string; archived: boolean; label?: string },
  requestClient: GatewayClient,
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    params,
    client: requestClient,
    context: context(),
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses;
}

describe("sessions.patch archive attribution", () => {
  it("stamps the transition actor, audits each transition, and preserves the first archiver", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:archive-attribution";
      const sessionId = "session-archive-attribution";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: 1, pinnedAt: 2 },
      );

      await patchSession({ key: sessionKey, archived: true }, client("profile-ada", "Ada"));
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        archivedAt: expect.any(Number),
        archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
      });

      await patchSession({ key: sessionKey, archived: true }, client("profile-bob", "Bob"));
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.archivedBy).toEqual({
        type: "human",
        id: "profile-ada",
        label: "Ada",
      });

      await patchSession({ key: sessionKey, archived: false }, client("profile-bob", "Bob"));
      const restored = loadSessionEntry({ agentId: "main", sessionKey });
      expect(restored?.archivedAt).toBeUndefined();
      expect(restored?.archivedBy).toBeUndefined();

      const noteContents = (
        await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey })
      ).flatMap((event) => {
        if (!event || typeof event !== "object" || !("message" in event)) {
          return [];
        }
        const message = event.message;
        if (
          !message ||
          typeof message !== "object" ||
          !("customType" in message) ||
          message.customType !== "openclaw.system-note" ||
          !("content" in message) ||
          typeof message.content !== "string"
        ) {
          return [];
        }
        return [message.content];
      });
      expect(noteContents).toEqual([
        "System note: archived by Ada",
        "System note: unarchived by Bob",
      ]);
    });
  });

  it("does not fabricate attribution or an actor-stamped audit for an unidentified client", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:solo-archive";
      const sessionId = "session-solo-archive";
      await upsertSessionEntry({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });

      await patchSession({ key: sessionKey, archived: true }, client());

      const archived = loadSessionEntry({ agentId: "main", sessionKey });
      expect(archived?.archivedAt).toEqual(expect.any(Number));
      expect(archived?.archivedBy).toBeUndefined();
      expect(await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey })).toEqual([]);
    });
  });

  it("rolls back the archive transition when its audit cannot be appended", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:archive-audit-failure";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-archive-audit-failure",
          updatedAt: 1,
          pinnedAt: 2,
          label: "original",
        },
      );
      const append = vi
        .spyOn(SessionManager.prototype, "appendMessage")
        .mockImplementationOnce(() => {
          throw new Error("audit unavailable");
        });

      try {
        await expect(
          invokePatchSession(
            { key: sessionKey, archived: true, label: "partial-success" },
            client("profile-ada", "Ada"),
          ),
        ).rejects.toThrow("audit unavailable");
      } finally {
        append.mockRestore();
      }

      const restored = loadSessionEntry({ agentId: "main", sessionKey });
      expect(restored?.archivedAt).toBeUndefined();
      expect(restored?.archivedBy).toBeUndefined();
      expect(restored?.pinnedAt).toBe(2);
      expect(restored?.label).toBe("original");
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { QueuedChatTurnEntry } from "../chat-queued-turns.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";

const sessionKey = "agent:main:queued-steer";
const sessionId = "queued-steer-incarnation";
const runId = "queued-input";

async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => run(await createFixture()));
}
async function createFixture() {
  const client = roleClient("write", "queued-steer-owner");
  client.connect.scopes = ["operator.sessions.write"];
  const cfg = rolePolicyConfig();
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId,
      updatedAt: 1,
      createdActor: {
        type: "human",
        source: "profile",
        id: client.authenticatedUserProfile!.profileId,
      },
    },
  );
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const steer = vi.fn<NonNullable<QueuedChatTurnEntry["steer"]>>(async (assertCurrent) => {
    assertCurrent();
    return { status: "accepted", targetRunId: "original-active-run" };
  });
  const entry: QueuedChatTurnEntry = {
    controller: new AbortController(),
    sessionId,
    sessionKey,
    agentId: "main",
    steer,
  };
  context.chatQueuedTurns.set(runId, entry);
  const request = async (params: Record<string, unknown> = {}, current = () => true) => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "promote",
        method: "chat.steer",
        params: { sessionKey, sessionId, runId, ...params },
      },
      context,
      client,
      respond,
      isWebchatConnect: () => true,
      hasCurrentClientAuthority: current,
    });
    return respond;
  };
  return { client, context, entry, steer, request };
}

describe("registered chat.steer authorization and source binding", () => {
  it("routes an authorized session-scoped request to the original queued source capability", async () => {
    await withFixture(async ({ request, steer, context, entry }) => {
      const respond = await request();
      expect(respond.mock.calls[0]?.slice(0, 2), JSON.stringify(respond.mock.calls)).toEqual([
        true,
        { status: "accepted", targetRunId: "original-active-run" },
      ]);
      expect(steer).toHaveBeenCalledOnce();
      expect(context.chatQueuedTurns.get(runId)).toBe(entry);
      expect(context.chatAbortControllers.size).toBe(0);
    });
  });

  it.each([
    "read-only",
    "foreign-session",
    "wrong-incarnation",
    "wrong-agent",
    "replacement-payload",
  ])("rejects %s without invoking the queue capability", async (kind) => {
    await withFixture(async ({ request, steer, client }) => {
      const params: Record<string, unknown> = {};
      if (kind === "read-only") {
        client.connect.scopes = ["operator.sessions.read"];
      }
      if (kind === "foreign-session") {
        const foreignSessionKey = "agent:main:foreign-queued-steer";
        params.sessionKey = foreignSessionKey;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: foreignSessionKey },
          {
            sessionId,
            updatedAt: 2,
            createdActor: { type: "human", source: "profile", id: "someone-else" },
          },
        );
      }
      if (kind === "wrong-incarnation") {
        params.sessionId = "replacement-incarnation";
      }
      if (kind === "wrong-agent") {
        params.agentId = "other";
      }
      if (kind === "replacement-payload") {
        params.message = "Do not reconstruct or replace input";
      }
      const respond = await request(params);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(steer).not.toHaveBeenCalled();
    });
  });

  it.each([
    "absent",
    "other-session",
    "other-agent",
    "other-incarnation",
    "cancelled",
    "collect-retired",
  ])("does not promote a queued identity that is %s", async (kind) => {
    await withFixture(async ({ context, entry, steer, request }) => {
      if (kind === "absent") {
        context.chatQueuedTurns.delete(runId);
      }
      if (kind === "other-session") {
        entry.sessionKey = "agent:main:elsewhere";
      }
      if (kind === "other-agent") {
        entry.agentId = "other";
      }
      if (kind === "other-incarnation") {
        entry.sessionId = "older-incarnation";
      }
      if (kind === "cancelled") {
        entry.controller.abort();
      }
      if (kind === "collect-retired") {
        entry.abortable = false;
      }
      const respond = await request();
      expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([true, { status: "not_queued" }]);
      expect(steer).not.toHaveBeenCalled();
    });
  });

  it.each(["source-replaced", "request-revoked", "session-reset"])(
    "rechecks %s after awaited work before injection",
    async (kind) => {
      await withFixture(async ({ context, entry, steer, request }) => {
        const entered = createDeferred();
        const release = createDeferred();
        const inject = vi.fn();
        let current = true;
        steer.mockImplementation(async (assertCurrent) => {
          entered.resolve();
          await release.promise;
          assertCurrent();
          inject();
          return { status: "accepted" };
        });
        const pending = request({}, () => current);
        await Promise.race([entered.promise, pending]);
        expect(steer).toHaveBeenCalledOnce();
        if (kind === "source-replaced") {
          context.chatQueuedTurns.set(runId, { ...entry, controller: new AbortController() });
        }
        if (kind === "request-revoked") {
          current = false;
        }
        if (kind === "session-reset") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            { sessionId: "new-incarnation", updatedAt: 3 },
          );
        }
        release.resolve();
        if (kind === "session-reset") {
          const respond = await pending;
          expect(respond.mock.calls[0]?.[0]).toBe(false);
        } else {
          await expect(pending).rejects.toThrow(
            kind === "source-replaced" ? "queued message changed" : "requester authority changed",
          );
        }
        expect(inject).not.toHaveBeenCalled();
      });
    },
  );

  it("preserves exact run IDs and reports a non-promotable queue without sending input", async () => {
    await withFixture(async ({ context, entry, request, steer }) => {
      context.chatQueuedTurns.delete(runId);
      context.chatQueuedTurns.set(" source with spaces ", entry);
      const absent = await request({ runId: "source with spaces" });
      expect(absent.mock.calls[0]?.slice(0, 2)).toEqual([true, { status: "not_queued" }]);
      expect(steer).not.toHaveBeenCalled();
      const exact = await request({ runId: " source with spaces " });
      expect(exact.mock.calls[0]?.[0]).toBe(true);
      expect(steer).toHaveBeenCalledOnce();
      delete entry.steer;
      const unavailable = await request({ runId: " source with spaces " });
      expect(unavailable.mock.calls[0]?.[1]).toMatchObject({
        status: "queued",
        reason: expect.stringContaining("remains queued"),
      });
    });
  });
});

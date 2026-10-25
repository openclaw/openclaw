import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { seedHistoryTranscript } from "./chat-history-fixture.test-support.js";
import { requestHistory } from "./chat-history-fixtures.test-support.js";
import * as historyPages from "./chat-history-pages.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import { prepareSubscriptionFixture } from "./sessions.messages-subscribe-wait.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it.each(["ready", "busy", "failed"] as const)(
  "admits the observer before initial history and retains its receipt when history is %s",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const client = {
        ...sharingPolicyClient({ scopes: ["operator.admin"] }),
        connId: "history-reader",
      };
      const subscribers = createSessionMessageSubscriberRegistry();
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:subscription-history",
        sessionId: "subscription-history",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "history-owner" },
      });
      await seedHistoryTranscript(scope, [["answer", { role: "assistant", content: "Ready" }]]);
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        subscribeSessionMessageEvents: subscribers.subscribe,
        unsubscribeSessionMessageEvents: subscribers.unsubscribe,
      });
      if (outcome === "ready") {
        const direct = await requestHistory(
          "chat.startup",
          { sessionKey: scope.sessionKey },
          context,
          client,
        );
        expect(direct.mock.calls[0]?.[0], JSON.stringify(direct.mock.calls)).toBe(true);
      }
      const readHistory = historyPages.readChatHistoryPage;
      let observedDuringRead = false;
      const read = vi.spyOn(historyPages, "readChatHistoryPage").mockImplementation((...args) => {
        observedDuringRead = subscribers.get(scope.sessionKey).has(client.connId);
        if (outcome !== "ready") {
          throw new WorkerTaskError(
            "synthetic history failure",
            outcome === "busy" ? "overloaded" : "failed",
          );
        }
        return readHistory(...args);
      });
      const respond = vi.fn<RespondFn>();
      try {
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "subscribe-with-history",
            method: "sessions.messages.subscribe",
            params: {
              key: scope.sessionKey,
              subscriptionId: "foreground",
              initialHistory: { limit: 80, maxBytes: 256 * 1024, toolResultMaxChars: 2_000 },
            },
          },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionSubscriptionHandlers,
        });
        expect(read, JSON.stringify(respond.mock.calls)).toHaveBeenCalledOnce();
        expect(observedDuringRead).toBe(true);
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          {
            subscribed: true,
            key: scope.sessionKey,
            agentId: scope.agentId,
            initialHistory:
              outcome === "ready"
                ? {
                    ok: true,
                    payload: expect.objectContaining({
                      messages: expect.arrayContaining([
                        expect.objectContaining({ role: "assistant", content: "Ready" }),
                      ]),
                    }),
                  }
                : {
                    ok: false,
                    error: expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
                  },
          },
          undefined,
        );
        expect(subscribers.get(scope.sessionKey)).toEqual(new Set([client.connId]));
        subscribers.unsubscribe(client.connId, scope.sessionKey, "foreground");
        expect(subscribers.get(scope.sessionKey).size).toBe(0);
      } finally {
        read.mockRestore();
        await disposeSessionReadContexts();
      }
    });
  },
);

it.each(["unchanged", "sharing", "replay"] as const)(
  "retains approval disclosure authority through initial history (%s)",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { cfg, client, subscribers, runtime } = await prepareSubscriptionFixture(
        state,
        `history-approval-${change}`,
        "operator.read",
      );
      cfg.agents = { entries: { main: {} } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:history-approval",
        sessionId: "history-approval",
      };
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "shared" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: "history-owner" },
      };
      await upsertSessionEntryCore(scope, entry);
      await seedHistoryTranscript(scope, [["answer", { role: "assistant", content: "Ready" }]]);
      let replayCurrent = true;
      const released = vi.fn();
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        subscribeSessionMessageEvents: subscribers.subscribe,
        listSessionPendingApprovals: async (...args) => {
          const prepared = await runtime.replay(...args);
          return {
            replay: prepared.replay,
            isCurrent: () => replayCurrent && prepared.isCurrent(),
            release: () => {
              released();
              prepared.release();
            },
          };
        },
      });
      prepareGatewayRecipientProfile(client);
      expect(client.preparedSessionProfile?.role).toBe("view");
      const readHistory = historyPages.readChatHistoryPage;
      let observedDuringRead = false;
      let releasedDuringRead = false;
      const read = vi
        .spyOn(historyPages, "readChatHistoryPage")
        .mockImplementation(async (...args) => {
          observedDuringRead = subscribers.get(scope.sessionKey).has(client.connId);
          releasedDuringRead = released.mock.calls.length > 0;
          const result = await readHistory(...args);
          if (change === "sharing") {
            await upsertSessionEntryCore(scope, { ...entry, visibility: "draft" });
          } else if (change === "replay") {
            replayCurrent = false;
          }
          return result;
        });
      const releasedAtResponse: boolean[] = [];
      const respond = vi.fn<RespondFn>(() => {
        releasedAtResponse.push(released.mock.calls.length > 0);
      });
      try {
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "subscribe-with-approval-history",
            method: "sessions.messages.subscribe",
            params: {
              key: scope.sessionKey,
              subscriptionId: "foreground",
              includeApprovals: true,
              initialHistory: { limit: 80, maxBytes: 256 * 1024 },
            },
          },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionSubscriptionHandlers,
        });
        expect(read, JSON.stringify(respond.mock.calls)).toHaveBeenCalledOnce();
        expect(observedDuringRead).toBe(true);
        if (change === "unchanged") {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            true,
            expect.objectContaining({
              approvalReplay: expect.objectContaining({ sessionKey: scope.sessionKey }),
              initialHistory: expect.objectContaining({ ok: true }),
            }),
            undefined,
          );
        } else {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              code: expect.stringMatching(/^(INVALID_REQUEST|UNAVAILABLE)$/),
            }),
          );
          expect(subscribers.get(scope.sessionKey).size).toBe(0);
          expect(subscribers.getApprovals(scope.sessionKey).size).toBe(0);
        }
        expect(releasedDuringRead).toBe(false);
        expect(releasedAtResponse).toEqual([false]);
        expect(released).toHaveBeenCalledOnce();
      } finally {
        read.mockRestore();
        subscribers.unsubscribeAll(client.connId);
        await disposeSessionReadContexts();
      }
    });
  },
);

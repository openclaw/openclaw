import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import { prepareSubscriptionFixture } from "./sessions.messages-subscribe-wait.test-support.js";

it.each(["operator.read", "operator.sessions.read"])(
  "keeps %s approval subscriptions across metadata updates but rejects changed access",
  (readScope) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { cfg, client, subscribers, runtime } = await prepareSubscriptionFixture(
        state,
        "metadata",
        readScope,
      );
      const key = "agent:main:subscribe-metadata";
      const scope = { agentId: "main", sessionKey: key };
      const entry: SessionEntry = {
        sessionId: "subscribe-metadata",
        lifecycleRevision: "original",
        updatedAt: 1,
        visibility: "shared",
      };
      replaceSessionEntrySync(scope, entry);
      let duringReplay = () => {};
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        subscribeSessionMessageEvents: subscribers.subscribe,
        listSessionPendingApprovals: async (...args) => {
          const prepared = await runtime.replay(...args);
          // A real committed write lands after admission and before the replay reply.
          duringReplay();
          return prepared;
        },
      });
      const cases: [name: string, update: Partial<SessionEntry>, allowed: boolean][] = [
        ["unchanged", {}, true],
        ["activity and label", { updatedAt: 2, label: "Still working", totalTokens: 123 }, true],
        ["visibility revoked", { visibility: "draft" }, false],
        ["session replaced", { sessionId: "replacement" }, false],
        ["lifecycle replaced", { lifecycleRevision: "replacement" }, false],
        ["incognito enabled", { incognito: true }, false],
      ];
      try {
        for (const [name, update, allowed] of cases) {
          replaceSessionEntrySync(scope, entry);
          const replayMutation = vi.fn(() =>
            replaceSessionEntrySync(scope, { ...entry, ...update }),
          );
          duringReplay = replayMutation;
          const respond = vi.fn();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: name,
              method: "sessions.messages.subscribe",
              params: { key, includeApprovals: true, subscriptionId: name },
            },
            client,
            context,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: sessionSubscriptionHandlers,
          });
          expect(replayMutation, name).toHaveBeenCalledOnce();
          const payload = allowed
            ? {
                subscribed: true,
                key,
                agentId: scope.agentId,
                approvalReplay: expect.objectContaining({ approvals: [], truncated: false }),
              }
            : undefined;
          const error = allowed
            ? undefined
            : expect.objectContaining({
                code: expect.stringMatching(/^(INVALID_REQUEST|UNAVAILABLE)$/),
              });
          expect(respond, name).toHaveBeenCalledExactlyOnceWith(allowed, payload, error);
          expect(subscribers.getApprovals(key), name).toEqual(
            new Set(allowed ? [client.connId] : []),
          );
          if (!allowed) {
            expect(subscribers.get(key), name).toEqual(new Set());
          }
          subscribers.unsubscribeAll(client.connId);
        }
      } finally {
        await disposeSessionReadContexts();
      }
    }),
);

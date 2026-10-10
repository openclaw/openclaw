import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperatorApprovalSessionEventRuntime } from "../operator-approval-session-events.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";

it.each(["operator.read", "operator.sessions.read"])(
  "keeps %s approval subscriptions across metadata updates but rejects changed access",
  async (readScope) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = rolePolicyConfig();
      cfg.gateway!.roles!.definitions.view!.scopes.push("operator.approvals");
      await state.writeConfig(cfg);
      const scope = { agentId: "main", sessionKey: "agent:main:subscribe-metadata" };
      const entry: SessionEntry = {
        sessionId: "subscribe-metadata",
        lifecycleRevision: "original",
        updatedAt: 1,
        visibility: "shared",
      };
      replaceSessionEntrySync(scope, entry);
      const client = { ...roleClient("view", "metadata-reader"), connId: "metadata-reader" };
      client.connect.scopes = [readScope, "operator.approvals"];
      client.connect.device = {
        id: "metadata-device",
        publicKey: "key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      };
      const subscribers = createSessionMessageSubscriberRegistry();
      const runtime = createOperatorApprovalSessionEventRuntime({
        clients: [client],
        sessionMessageSubscribers: subscribers,
        broadcastToConnIds: () => {},
      });
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
      const cases: Array<{ name: string; update: Partial<SessionEntry>; allowed: boolean }> = [
        { name: "unchanged", update: {}, allowed: true },
        {
          name: "activity and label",
          update: { updatedAt: 2, label: "Still working", totalTokens: 123 },
          allowed: true,
        },
        { name: "visibility revoked", update: { visibility: "draft" }, allowed: false },
        { name: "session replaced", update: { sessionId: "replacement" }, allowed: false },
        {
          name: "lifecycle replaced",
          update: { lifecycleRevision: "replacement" },
          allowed: false,
        },
        { name: "incognito enabled", update: { incognito: true }, allowed: false },
      ];
      try {
        for (const { name, update, allowed } of cases) {
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
              params: { key: scope.sessionKey, includeApprovals: true, subscriptionId: name },
            },
            client,
            context,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: sessionSubscriptionHandlers,
          });
          expect(replayMutation, name).toHaveBeenCalledOnce();
          if (allowed) {
            expect(respond, name).toHaveBeenCalledExactlyOnceWith(
              true,
              {
                subscribed: true,
                key: scope.sessionKey,
                agentId: scope.agentId,
                approvalReplay: expect.objectContaining({ approvals: [], truncated: false }),
              },
              undefined,
            );
            expect(subscribers.getApprovals(scope.sessionKey), name).toEqual(
              new Set([client.connId]),
            );
          } else {
            expect(respond, name).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              // Narrow reads also revalidate access in the router response guard.
              expect.objectContaining({
                code: expect.stringMatching(/^(INVALID_REQUEST|UNAVAILABLE)$/),
              }),
            );
            expect(subscribers.get(scope.sessionKey), name).toEqual(new Set());
            expect(subscribers.getApprovals(scope.sessionKey), name).toEqual(new Set());
          }
          subscribers.unsubscribeAll(client.connId);
        }
      } finally {
        await disposeSessionReadContexts();
      }
    });
  },
);

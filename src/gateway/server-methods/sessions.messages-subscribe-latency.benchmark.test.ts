import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperatorApprovalSessionEventRuntime } from "../operator-approval-session-events.js";
import * as approvals from "../operator-approval-store.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import * as lifetime from "../session-utils-read-lifetime.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";

afterEach(() => vi.restoreAllMocks());

it("measures subscription dispatch with a 160k-token transcript", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = rolePolicyConfig();
    cfg.gateway!.roles!.definitions.view!.scopes.push("operator.approvals");
    await state.writeConfig(cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:subscribe-perf",
      sessionId: "subscribe-perf",
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "shared",
    });
    const subscribers = createSessionMessageSubscriberRegistry();
    const client = { ...roleClient("view", "perf-reader"), connId: "perf-reader" };
    client.connect.scopes = ["operator.sessions.read", "operator.approvals"];
    client.connect.device = {
      id: "perf-device",
      publicKey: "key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    };
    const runtime = createOperatorApprovalSessionEventRuntime({
      clients: [client],
      sessionMessageSubscribers: subscribers,
      broadcastToConnIds: () => {},
    });
    const context = await createHistoryReadContext({
      getRuntimeConfig: () => cfg,
      subscribeSessionMessageEvents: subscribers.subscribe,
      listSessionPendingApprovals: runtime.replay,
    });
    const phaseMs = { expiry: 0, pending: 0 };
    const expire = approvals.expireDueOperatorApprovals;
    const pending = approvals.listPendingOperatorApprovals;
    vi.spyOn(approvals, "expireDueOperatorApprovals").mockImplementation(async (...args) => {
      const start = performance.now();
      try {
        return await expire(...args);
      } finally {
        phaseMs.expiry += performance.now() - start;
      }
    });
    vi.spyOn(approvals, "listPendingOperatorApprovals").mockImplementation(async (...args) => {
      const start = performance.now();
      try {
        return await pending(...args);
      } finally {
        phaseMs.pending += performance.now() - start;
      }
    });
    const projection = getSessionRowProjection(context)!;
    let readMs = 0;
    let currencyReads = 0;
    const retain = lifetime.retainGatewaySessionEntryReadOnly;
    vi.spyOn(lifetime, "retainGatewaySessionEntryReadOnly").mockImplementation((...args) => {
      const start = performance.now();
      const read = retain(...args);
      readMs += performance.now() - start;
      const assert = read.isCurrentAtResponse;
      return {
        ...read,
        isCurrentAtResponse: () => {
          currencyReads++;
          const validationStartedAt = performance.now();
          try {
            return assert();
          } finally {
            readMs += performance.now() - validationStartedAt;
          }
        },
      };
    });
    try {
      for (const events of [0, 2000]) {
        if (events) {
          await persistSessionTranscriptTurn(scope, {
            messages: Array.from({ length: events }, (_, index) => ({
              eventId: `message-${index}`,
              message: {
                role: "user",
                content: [{ type: "text", text: "word ".repeat(80) }],
                timestamp: index + 1,
              },
            })),
            updateMode: "none",
          });
          await projection.ensureMaterialized();
        }
        for (const includeApprovals of [false, true]) {
          const samples: number[] = [];
          readMs = 0;
          currencyReads = 0;
          phaseMs.expiry = 0;
          phaseMs.pending = 0;
          for (let index = 0; index < 50; index++) {
            const respond = vi.fn();
            const start = performance.now();
            await handleGatewayRequest({
              req: {
                type: "req",
                id: `${index}`,
                method: "sessions.messages.subscribe",
                params: {
                  key: scope.sessionKey,
                  ...(includeApprovals ? { includeApprovals: true } : {}),
                },
              },
              client,
              context,
              respond,
              isWebchatConnect: () => false,
              extraHandlers: sessionSubscriptionHandlers,
            });
            samples.push(performance.now() - start);
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              true,
              expect.objectContaining({ subscribed: true, key: scope.sessionKey, agentId: "main" }),
              undefined,
            );
          }
          samples.sort((a, b) => a - b);
          console.log(
            JSON.stringify({
              events,
              includeApprovals,
              estimatedTokens: events * 80,
              samples: samples.length,
              meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
              p50Ms: samples[25],
              p99Ms: samples[49],
              retainedReadMs: readMs / samples.length,
              expiryMs: phaseMs.expiry / samples.length,
              pendingMs: phaseMs.pending / samples.length,
              currencyReadsPerSubscribe: currencyReads / samples.length,
            }),
          );
          // Capture validates once; recheck only after replay and before committing the observer.
          expect(currencyReads).toBeLessThanOrEqual(samples.length * (includeApprovals ? 3 : 2));
        }
      }
    } finally {
      await disposeSessionReadContexts();
    }
  });
});

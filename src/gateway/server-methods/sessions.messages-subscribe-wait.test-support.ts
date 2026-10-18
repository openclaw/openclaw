import { performance } from "node:perf_hooks";
import { expect, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperatorApprovalSessionEventRuntime } from "../operator-approval-session-events.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sessionLog } from "../session-log.js";
import * as rowFacts from "../session-row-database-facts.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";

/** Hold display preparation at its owner, whether facts come from receipts or a worker. */
export async function proveSubscriptionDoesNotWaitForDisplayRows(
  sessionCount: number,
  signal: AbortSignal,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = rolePolicyConfig();
    cfg.gateway!.roles!.definitions.view!.scopes.push("operator.approvals");
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:subscribe-dirty-row",
      sessionId: "subscribe-dirty-row",
    };
    const shared = { sessionId: scope.sessionId, updatedAt: 1, visibility: "shared" as const };
    replaceSessionEntrySync(scope, shared);
    for (let index = 1; index < sessionCount; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:subscribe-neighbor-${index}` },
        { sessionId: `subscribe-neighbor-${index}`, updatedAt: 1, visibility: "shared" },
      );
    }
    const client = { ...roleClient("view", "dirty-row-reader"), connId: "dirty-row-reader" };
    client.connect.scopes = ["operator.sessions.read", "operator.approvals"];
    client.connect.device = {
      id: "dirty-row-device",
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
    const runId = "subscribe-active-turn";
    registerAgentRunContext(runId, { ...scope, projectSessionActive: true });
    const context = await createHistoryReadContext({
      getRuntimeConfig: () => cfg,
      subscribeSessionMessageEvents: subscribers.subscribe,
      listSessionPendingApprovals: runtime.replay,
    });
    const projection = getSessionRowProjection(context)!;
    const displayEntered = createDeferredCore();
    const releaseDisplay = createDeferredCore();
    const displayPreparationEntered = createDeferredCore();
    const readFacts = rowFacts.withSessionRowDatabaseFacts;
    let heldDisplayPreparations = 0;
    let displayReleased = false;
    const displayRead = vi
      .spyOn(rowFacts, "withSessionRowDatabaseFacts")
      .mockImplementation(async (owner, consume) => {
        const selected = owner.selected ?? owner.dirty;
        if (
          !displayReleased &&
          [...selected].some((id) => owner.rows.get(id)?.key === scope.sessionKey)
        ) {
          heldDisplayPreparations++;
          displayEntered.resolve();
          await releaseDisplay.promise;
        }
        return readFacts(owner, consume);
      });
    const prepareRows = projection.withPreparedExactRows.bind(projection);
    const prepare = vi.spyOn(projection, "withPreparedExactRows").mockImplementation((...args) => {
      const result = prepareRows(...args);
      displayPreparationEntered.resolve();
      return result;
    });
    const pending: Promise<unknown>[] = [];
    const previousDiagnostics = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    const logEnabled = vi.spyOn(sessionLog, "isEnabled").mockReturnValue(true);
    const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
    let clock: { mockRestore: () => void } | undefined;
    const release = () => {
      displayReleased = true;
      releaseDisplay.resolve();
    };
    try {
      const turn = await persistSessionTranscriptTurn(scope, {
        messages: [
          { eventId: "active-turn-output", message: { role: "assistant", content: "Working" } },
        ],
        expectedSessionId: scope.sessionId,
        runId,
        touchSessionEntry: true,
        updateMode: "file-only",
      });
      expect(turn.appendedCount).toBe(1);
      const refresh = projection.ensureMaterialized();
      pending.push(refresh);
      await withinTest(
        awaitGateBeforeSettlement(
          displayEntered.promise,
          refresh,
          "Dirty row did not reach display preparation",
        ),
        signal,
      );
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      let elapsed = 0;
      const realNow = performance.now.bind(performance);
      clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const wallStartedAt = realNow();
      const responses = [false, true].map((includeApprovals) => {
        const respond = vi.fn();
        const completion = handleGatewayRequest({
          req: {
            type: "req",
            id: `subscribe-${includeApprovals}`,
            method: "sessions.messages.subscribe",
            params: {
              key: scope.sessionKey,
              ...(includeApprovals ? { includeApprovals: true } : {}),
              subscriptionId: `observer-${includeApprovals}`,
            },
          },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionSubscriptionHandlers,
        });
        pending.push(completion);
        return { respond, completion, includeApprovals };
      });
      const subscriptions = Promise.all(responses.map(({ completion }) => completion));
      const first = await withinTest(
        Promise.race([
          subscriptions.then(() => "subscribed" as const),
          displayPreparationEntered.promise.then(() => "display-wait" as const),
        ]),
        signal,
      );
      if (first === "display-wait") {
        // A fixed external delay makes the baseline fail promptly without sleeping or polling.
        elapsed = 1_500;
        release();
      }
      await withinTest(subscriptions, signal);
      console.log(
        JSON.stringify({
          sessionCount,
          heldDisplayPreparations,
          subscriptionWaitMs: elapsed,
          wallMs: realNow() - wallStartedAt,
          displayReleasedBeforeReply: displayReleased,
          diagnostics: warn.mock.calls,
        }),
      );
      expect(elapsed, "subscription waited for unrelated display-row preparation").toBe(0);
      expect(displayReleased).toBe(false);
      for (const { respond, includeApprovals } of responses) {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          {
            subscribed: true,
            key: scope.sessionKey,
            agentId: "main",
            ...(includeApprovals
              ? {
                  approvalReplay: expect.objectContaining({
                    sessionKey: scope.sessionKey,
                    approvals: [],
                  }),
                }
              : {}),
          },
          undefined,
        );
      }
      expect([...subscribers.get(scope.sessionKey)]).toEqual([client.connId]);
      expect([...subscribers.getApprovals(scope.sessionKey)]).toEqual([client.connId]);

      replaceSessionEntrySync(scope, { ...shared, updatedAt: 3, visibility: "draft" });
      const denied = vi.fn();
      await withinTest(
        handleGatewayRequest({
          req: {
            type: "req",
            id: "revoked",
            method: "sessions.messages.subscribe",
            params: { key: scope.sessionKey },
          },
          client: { ...client, connId: "revoked-reader" },
          context,
          respond: denied,
          isWebchatConnect: () => false,
          extraHandlers: sessionSubscriptionHandlers,
        }),
        signal,
      );
      expect(denied).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(subscribers.get(scope.sessionKey).has("revoked-reader")).toBe(false);
    } finally {
      setDiagnosticsEnabledForProcess(previousDiagnostics);
      logEnabled.mockRestore();
      warn.mockRestore();
      clock?.mockRestore();
      prepare.mockRestore();
      release();
      await Promise.allSettled(pending);
      displayRead.mockRestore();
      clearAgentRunContext(runId);
      await disposeSessionReadContexts();
    }
  });
}

import { performance } from "node:perf_hooks";
import { expect, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import * as history from "../../config/sessions/session-transcript-worker-runtime.js";
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
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";

/** The worker completes real SQLite work; only delivery of its display facts is held. */
export async function proveSubscriptionDoesNotWaitForDisplayRows(
  sessionCount: number,
  signal: AbortSignal,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = rolePolicyConfig();
    cfg.gateway!.roles!.definitions.view!.scopes.push("operator.approvals");
    await state.writeConfig(cfg);
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
    const workerEntered = createDeferredCore();
    const releaseWorker = createDeferredCore();
    const displayPreparationEntered = createDeferredCore();
    const readDatabases = history.withSessionHistoryWorkerDatabases;
    let heldWorkerReads = 0;
    let workerReleased = false;
    const workerRead = vi
      .spyOn(history, "withSessionHistoryWorkerDatabases")
      .mockImplementation((selected, consume, lane) =>
        readDatabases(
          selected,
          (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readRowFacts(input) {
                  const reply = await owner.readRowFacts(input);
                  if (!workerReleased && input.sessionKeys.includes(scope.sessionKey)) {
                    heldWorkerReads++;
                    workerEntered.resolve();
                    await releaseWorker.promise;
                  }
                  return reply;
                },
              })),
            ),
          lane,
        ),
      );
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
      workerReleased = true;
      releaseWorker.resolve();
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
          workerEntered.promise,
          refresh,
          "Dirty row did not reach its worker",
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
          heldWorkerReads,
          subscriptionWaitMs: elapsed,
          wallMs: realNow() - wallStartedAt,
          workerReleasedBeforeReply: workerReleased,
          diagnostics: warn.mock.calls,
        }),
      );
      expect(elapsed, "subscription waited for unrelated display-row worker facts").toBe(0);
      expect(workerReleased).toBe(false);
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
      workerRead.mockRestore();
      clearAgentRunContext(runId);
      await disposeSessionReadContexts();
    }
  });
}

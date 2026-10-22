import { expect, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createOperatorApprovalSessionEventRuntime } from "../operator-approval-session-events.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import * as rowFacts from "../session-row-database-facts.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";

export async function prepareSubscriptionFixture(
  state: OpenClawTestState,
  name: string,
  readScope = "operator.sessions.read",
) {
  const cfg = rolePolicyConfig();
  cfg.gateway!.roles!.definitions.view!.scopes.push("operator.approvals");
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const client = { ...roleClient("view", `${name}-reader`), connId: `${name}-reader` };
  client.connect.scopes = [readScope, "operator.approvals"];
  client.connect.device = sharingPolicyClient({ deviceId: `${name}-device` }).connect.device;
  const subscribers = createSessionMessageSubscriberRegistry();
  const runtime = createOperatorApprovalSessionEventRuntime({
    clients: [client],
    sessionMessageSubscribers: subscribers,
    broadcastToConnIds: () => {},
  });
  return { cfg, client, subscribers, runtime };
}

/** Hold display preparation at its owner, whether facts come from receipts or a worker. */
export async function proveSubscriptionDoesNotWaitForDisplayRows(
  sessionCount: number,
  signal: AbortSignal,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { cfg, client, subscribers, runtime } = await prepareSubscriptionFixture(
      state,
      "dirty-row",
    );
    const sessionId = "subscribe-dirty-row";
    const scope = { agentId: "main", sessionKey: `agent:main:${sessionId}`, sessionId };
    const { sessionKey } = scope;
    const wait = <T>(promise: Promise<T>) => withinTest(promise, signal);
    const shared = { sessionId: scope.sessionId, updatedAt: 1, visibility: "shared" as const };
    replaceSessionEntrySync(scope, shared);
    for (let index = 1; index < sessionCount; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:subscribe-neighbor-${index}` },
        { sessionId: `subscribe-neighbor-${index}`, updatedAt: 1, visibility: "shared" },
      );
    }
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
    let displayReleased = false;
    const displayRead = vi
      .spyOn(rowFacts, "withSessionRowDatabaseFacts")
      .mockImplementation(async (owner, consume) => {
        const selected = owner.selected ?? owner.dirty;
        if (
          !displayReleased &&
          [...selected].some((id) => owner.rows.get(id)?.key === sessionKey)
        ) {
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
    const release = () => {
      displayReleased = true;
      releaseDisplay.resolve();
    };
    const request = (id: string, params: Record<string, unknown>, requestClient = client) => {
      const respond = vi.fn();
      const completion = handleGatewayRequest({
        req: { type: "req", id, method: "sessions.messages.subscribe", params },
        client: requestClient,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: sessionSubscriptionHandlers,
      });
      pending.push(completion);
      return { respond, completion };
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
      await wait(
        awaitGateBeforeSettlement(
          displayEntered.promise,
          refresh,
          "Dirty row did not reach display preparation",
        ),
      );
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      const responses = [false, true].map((includeApprovals) =>
        Object.assign(
          request(`subscribe-${includeApprovals}`, {
            key: sessionKey,
            ...(includeApprovals ? { includeApprovals: true } : {}),
            subscriptionId: `observer-${includeApprovals}`,
          }),
          { includeApprovals },
        ),
      );
      const subscriptions = Promise.all(responses.map(({ completion }) => completion));
      const first = await wait(
        Promise.race([
          subscriptions.then(() => "subscribed" as const),
          displayPreparationEntered.promise.then(() => "display-wait" as const),
        ]),
      );
      if (first === "display-wait") {
        // Let a regressed subscription settle before asserting the race winner.
        release();
      }
      await wait(subscriptions);
      expect(first, "subscription waited for unrelated display-row preparation").toBe("subscribed");
      expect(displayReleased).toBe(false);
      const payload = { subscribed: true, key: sessionKey, agentId: "main" };
      const approvalReplay = expect.objectContaining({ sessionKey, approvals: [] });
      for (const { respond, includeApprovals } of responses) {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          { ...payload, ...(includeApprovals ? { approvalReplay } : {}) },
          undefined,
        );
      }
      expect([...subscribers.get(sessionKey)]).toEqual([client.connId]);
      expect([...subscribers.getApprovals(sessionKey)]).toEqual([client.connId]);
      replaceSessionEntrySync(scope, { ...shared, updatedAt: 3, visibility: "draft" });
      const revokedClient = { ...client, connId: "revoked-reader" };
      const denied = request("revoked", { key: sessionKey }, revokedClient);
      await wait(denied.completion);
      expect(denied.respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(subscribers.get(sessionKey).has("revoked-reader")).toBe(false);
    } finally {
      prepare.mockRestore();
      release();
      await Promise.allSettled(pending);
      displayRead.mockRestore();
      clearAgentRunContext(runId);
      await disposeSessionReadContexts();
    }
  });
}

// Real Gateway admission/replay and SQLite settlement with controlled agent-command execution.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../agents/subagents/announce/subagent-announce.requester-settle-wake.js";
import { settleRequesterCompletionBatch } from "../agents/subagents/completion/subagent-completion-admission.store.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  bindSubagentRunRecord,
  loadSubagentRegistryFromSqlite,
  upsertSubagentRunRowInDatabase,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

describe("public yielded settle replay with real Gateway admission", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  let sequence = 0;
  let requesterSessionKey: string;
  let requesterSessionId: string;
  let child: SubagentRunRecord;

  async function start() {
    const module = await import("./server-kernel.js");
    const create = module.createGatewayKernel;
    const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
      kernel = await create(...args);
      return kernel;
    });
    try {
      harness = await startGatewayServerHarness();
    } finally {
      capture.mockRestore();
    }
  }
  installGatewayTestHooks({ scope: "suite", setup: start, cleanup: async () => harness?.close() });

  beforeEach(async () => {
    sequence += 1;
    requesterSessionKey = `agent:main:settle-replay-${sequence}`;
    requesterSessionId = `settle-replay-parent-${sequence}`;
    testState.sessionStorePath = path.join(
      process.env.OPENCLAW_STATE_DIR!,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    await writeSessionStore({
      entries: { [requesterSessionKey]: { sessionId: requesterSessionId, updatedAt: Date.now() } },
    });
    agentCommandMock.mockReset();
    await prepareGatewayReplyRuntimeForTest();
    const now = Date.now();
    child = {
      runId: `settle-replay-child-${sequence}`,
      childSessionKey: `agent:main:subagent:settle-replay-child-${sequence}`,
      requesterSessionKey,
      requesterDisplayKey: requesterSessionKey,
      requesterAgentId: "main",
      requesterStorePath: resolvePhysicalSessionStorePath({ sessionKey: requesterSessionKey }),
      task: "Return the isolated child result",
      cleanup: "keep",
      createdAt: now - 30,
      execution: {
        status: "terminal",
        startedAt: now - 20,
        endedAt: now - 10,
        outcome: { status: "ok" },
      },
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "isolated child result", capturedAt: now - 10 },
      // A delivered child can be included in a later yielded requester batch.
      // Its old delivery receipt does not discharge that new synthesis obligation.
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "dispatching",
        attemptCount: 1,
        batchRunIds: [`settle-replay-child-${sequence}`],
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
      },
    };
    subagentRuns.set(child.runId, child);
    bindGatewayContextResolver(child, () => kernel.gatewayRequestContext);
    persistChild();
  });

  afterEach(() => {
    subagentRuns.delete(child.runId);
  });

  function persistChild() {
    upsertSubagentRunRowInDatabase(openOpenClawStateDatabase(), bindSubagentRunRecord(child));
  }

  const finalResult = (): Exclude<Awaited<ReturnType<typeof agentCommandMock>>, void> => ({
    payloads: [{ text: "Requester synthesis is complete.", mediaUrl: null }],
    meta: { durationMs: 1, finalAssistantVisibleText: "Requester synthesis is complete." },
    deliveryStatus: {
      requested: true,
      attempted: true,
      succeeded: true,
      status: "sent",
      resultCount: 1,
    },
  });

  function wake() {
    const completeBatch = vi.fn<
      Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0]["completeBatch"]
    >((batch, _generation, outcome, onCommitted) => {
      expect(outcome).toBeDefined();
      settleRequesterCompletionBatch({
        entries: batch.map((subagent) => ({ subagent })),
        outcome: outcome!,
        isCurrent: () => subagentRuns.get(child.runId) === child,
      });
      onCommitted?.();
    });
    return {
      completeBatch,
      result: maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey,
        settledEntry: child,
        transitionBatch: (_batch, state) => {
          child.requesterSettleWake = state;
          persistChild();
        },
        completeBatch,
      }),
    };
  }

  it.each(["success", "failure"] as const)(
    "retains real in_flight replay custody and reconciles terminal %s",
    async (outcome) => {
      const entered = createDeferred();
      const release = createDeferred();
      agentCommandMock.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        if (outcome === "failure") {
          throw new Error("isolated requester provider failure");
        }
        return finalResult();
      });
      const runId = buildAnnounceIdempotencyKey(
        `requester-settle:main:${requesterSessionKey}:${child.runId}:yield-1`,
      );
      // Prime real admission, not a seeded dedupe entry or a mocked startTurn.
      // The persisted dispatching wake represents an observer that must replay.
      const original = dispatchGatewayMethodInProcess<Record<string, unknown>>(
        "agent",
        {
          sessionKey: requesterSessionKey,
          idempotencyKey: runId,
          message: "Synthesize the isolated completed child result.",
          deliver: false,
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: child.childSessionKey,
            sourceChannel: "internal",
            sourceTool: "subagent_settle",
          },
        },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: () => kernel.gatewayRequestContext,
        },
      );
      // Observe rejection immediately, including if admission itself fails.
      const terminal = original.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          terminal.then((result) => {
            if ("error" in result) {
              throw result.error;
            }
          }),
        ]);
        expect(kernel.gatewayRequestContext.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
          runId,
          status: "accepted",
        });
        const replay = wake();
        expect(await replay.result).toBe(false);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(replay.completeBatch).not.toHaveBeenCalled();
        expect(
          loadSubagentRegistryFromSqlite().get(child.runId)?.requesterSettleWake,
        ).toMatchObject({
          status: "dispatching",
          attemptCount: 1,
          rearmGeneration: 1,
        });
        const replayDueAt = child.requesterSettleWake?.nextAttemptAt;
        expect(replayDueAt).toBeGreaterThan(Date.now());
        release.resolve();
        await terminal;
        expect(agentCommandMock).toHaveBeenCalledOnce();
        // Only advance Date after original execution has settled. No Gateway
        // timers run early and the persisted owner/deadline remain unchanged.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(replayDueAt! + 1);
        const reconciliation = wake();
        expect(await reconciliation.result).toBe(outcome === "success");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        const persisted = loadSubagentRegistryFromSqlite().get(child.runId);
        if (outcome === "success") {
          expect(reconciliation.completeBatch).toHaveBeenCalledOnce();
          expect(reconciliation.completeBatch.mock.calls[0]?.[2]).toMatchObject({
            delivered: true,
            requesterVisibleFinalDelivered: true,
          });
          expect(persisted?.requesterSettleWake).toBeUndefined();
        } else {
          // A known failed turn may rotate the next attempt, but cannot silently
          // discharge the owed synthesis as delivered.
          expect(reconciliation.completeBatch).not.toHaveBeenCalled();
          expect(persisted?.requesterSettleWake).toMatchObject({
            status: "pending",
            attemptCount: 1,
            rearmGeneration: 1,
          });
          expect(persisted?.requesterSettleWake?.lastError).toBeTruthy();
        }
      } finally {
        vi.useRealTimers();
        release.resolve();
        await terminal;
      }
    },
  );

  it("settles the canonical wake after a terminal visible final", async () => {
    agentCommandMock.mockImplementationOnce(async () => finalResult());
    const completion = wake();
    expect(await completion.result).toBe(true);
    expect(agentCommandMock).toHaveBeenCalledOnce();
    expect(completion.completeBatch).toHaveBeenCalledOnce();
    expect(completion.completeBatch.mock.calls[0]?.[2]).toMatchObject({
      delivered: true,
      requesterVisibleFinalDelivered: true,
    });
    expect(loadSubagentRegistryFromSqlite().get(child.runId)?.requesterSettleWake).toBeUndefined();
  });
});

import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { listRunsForControllerFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  registerSubagentRun,
  withSubagentKillOwner,
} from "../agents/subagents/registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "../agents/subagents/registry/subagent-run-generation.js";
import * as swarm from "../agents/subagents/swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../agents/subagents/swarm/swarm-scheduler.test-support.js";
import * as sessions from "../config/sessions/session-accessor.js";
import {
  beginSessionEffect,
  getSessionMutationCount,
  getSessionControllerWorkCount,
  type SessionEffectRef,
} from "../sessions/session-controller.lifecycle.js";
import { observeGatewayConnectionWork } from "./server-held-work.test-support.js";
import * as fixture from "./test-helpers.js";

let gateway: Awaited<ReturnType<typeof fixture.createGatewaySuiteHarness>>;
let connectionObserver: Awaited<ReturnType<typeof observeGatewayConnectionWork>>;
fixture.installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    connectionObserver = await observeGatewayConnectionWork();
    try {
      gateway = await fixture.createGatewaySuiteHarness();
    } finally {
      connectionObserver.stopCapture();
    }
  },
  cleanup: async () => {
    await runQaGatewayFixture(
      async () => gateway?.close(),
      () => connectionObserver.restore(),
      async () => {
        await settleSubagentRegistryPersistenceWork();
        await resetSubagentRegistryForTests({ persist: false });
        schedulerTesting.reset();
      },
    );
  },
});

await import("./server.js");
// Prepare the lazy handler before the first creation RPC starts its response deadline.
await import("./server-methods/sessions-create.js");

for (const [suffix, name] of [
  ["success", "public session creation and child Stop publish readable cancellation state"],
  ["fault", "chat.abort interrupts all siblings before cleanup and preserves failure accounting"],
  [
    "replacement",
    "typed Stop rejects a replaced parent while retaining its accepted child cancellation",
  ],
] as const) {
  test(name, async () => {
    const fault = suffix === "fault";
    const replaceParent = suffix === "replacement";
    const parentRunId = `parent-${suffix}`;
    const parentKey = `agent:main:sibling-abort-${suffix}`;
    const groupId = `sibling-abort-${suffix}`;
    const running = Array.from(
      { length: fault ? 8 : 1 },
      (_, index) => `running-${suffix}-${index}`,
    );
    const firstRunId = expectDefined(running[0], "first running child");
    const queued = fault ? [`queued-${suffix}-0`, `queued-${suffix}-1`] : [];
    const selected = [...running, ...queued];
    const failedRunId = fault ? running[3] : undefined;
    const sessionKey = (runId: string) => `agent:main:subagent:${runId}`;
    const stateDir = process.env.OPENCLAW_STATE_DIR!;
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    let parentSessionId = `parent-session-${suffix}`;
    const replacementScope = {
      storePath,
      agentId: "main",
      sessionKey: parentKey,
      sessionId: `replacement-session-${suffix}`,
    };
    const replacementCanary = "The replacement conversation must survive the earlier Stop.";
    let replacementBefore: Awaited<ReturnType<typeof sessions.loadTranscriptEvents>> | undefined;
    fixture.testState.sessionStorePath = storePath;
    const seedSession = (key: string, id: string) =>
      writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: key,
        defaultSessionId: id,
      });
    if (fault || replaceParent) {
      // Prior cases still have Gateway-owned monitors; preserve their rows.
      await seedSession(parentKey, parentSessionId);
    }

    const socket = await gateway.openWs();
    const parentStarted = createDeferred<AgentCommandOpts>();
    const parentFinish = createDeferred();
    const leases: SessionEffectRef[] = [];
    const releasedLeases = new Set<SessionEffectRef>();
    const interrupted: string[] = [];
    const firstInterrupted = createDeferred();
    const slotReleaseResults: boolean[] = [];
    const start = vi.fn(async () => {});
    const reserve = (runId: string, maxConcurrent: number) =>
      swarm.reserveSwarmRun({ groupId, runId, maxConcurrent, activeRunIds: running });
    let parentRequestId: string | undefined;
    let parentTerminal: Promise<PromiseSettledResult<unknown>> | undefined;
    let abortResponse: ReturnType<typeof fixture.rpcReq> | undefined;
    let abortOutcome:
      | Promise<PromiseSettledResult<Awaited<ReturnType<typeof fixture.rpcReq>>>>
      | undefined;
    let responseSettled = false;
    let acceptedKillIntent: SubagentRunRecord["killIntent"];
    const expectResponse = (
      response: Awaited<ReturnType<typeof fixture.rpcReq>>,
      shape: Record<string, unknown>,
    ) => expect(response, JSON.stringify(response.error)).toMatchObject(shape);
    const runtimeKey = (runId: string) => getSubagentRunRuntimeKey(subagentRuns.get(runId)!);
    const describe = async (
      key: string,
      sessionId: string,
      fields: Record<string, unknown> = {},
    ) => {
      const response = await fixture.rpcReq(socket, "sessions.describe", { key, agentId: "main" });
      expectResponse(response, {
        ok: true,
        payload: { session: { key, sessionId, ...fields } },
      });
    };

    const cancellationInspected = createDeferred();
    // Hold the child's kill owner: an aborted parent no longer delays confirmation,
    // which can legitimately retire a non-collecting child before this inspection.
    const cancellationOwner = replaceParent
      ? withSubagentKillOwner(firstRunId, () => cancellationInspected.promise)
      : undefined;
    await runQaGatewayFixture(
      async () => {
        if (!fault && !replaceParent) {
          await fixture.prepareGatewayReplyRuntimeForTest({ force: true });
        }
        await fixture.connectOk(socket, {
          scopes: ["operator.read", "operator.write"],
          prePairDevice: true,
        });
        if (!fault && !replaceParent) {
          const created = await fixture.rpcReq<{ key: string; sessionId: string }>(
            socket,
            "sessions.create",
            {
              agentId: "main",
              key: parentKey,
            },
          );
          expectResponse(created, {
            ok: true,
            payload: { key: parentKey },
          });
          parentSessionId = expectDefined(created.payload, "created non-main parent").sessionId;
          expect(parentSessionId).not.toBe("");
        }
        fixture.agentCommandMock.mockImplementationOnce(async (input) => {
          const command = input as AgentCommandOpts;
          expect(command.abortSignal).toBeInstanceOf(AbortSignal);
          await command.onExecutionStarted?.();
          command.abortSignal!.addEventListener("abort", () => parentFinish.resolve(), {
            once: true,
          });
          parentStarted.resolve(command);
          await parentFinish.promise;
          command.abortSignal!.throwIfAborted();
        });
        const accepted = await fixture.rpcReq(socket, "agent", {
          sessionKey: parentKey,
          message: "Keep this synthetic parent active until Stop",
          idempotencyKey: parentRunId,
        });
        parentRequestId = accepted.id;
        expectResponse(accepted, {
          ok: true,
          payload: { runId: parentRunId, status: "accepted" },
        });
        const parent = await parentStarted.promise;
        expect(fixture.agentCommandMock).toHaveBeenCalledTimes(1);

        for (const runId of selected) {
          const childStorePath = await seedSession(sessionKey(runId), `${runId}-session`);
          if (running.includes(runId)) {
            // Recovery must observe the live owner when the run is registered.
            leases.push(
              await beginSessionEffect({
                scope: storePath,
                identities: [sessionKey(runId), `${runId}-session`],
                resolveGatewayContext: expectDefined(
                  connectionObserver.context,
                  "Gateway fixture context",
                ).resolveGatewayContext,
                run: {
                  runId,
                  sessionKey: sessionKey(runId),
                  sessionId: `${runId}-session`,
                  agentId: "main",
                },
                assertAllowed: () => {},
                onInterrupt: () => {
                  interrupted.push(runId);
                  firstInterrupted.resolve();
                  slotReleaseResults.push(swarm.releaseSwarmRun(runId));
                  if (runId === failedRunId) {
                    throw new Error("synthetic sibling interruption failure");
                  }
                  return { runId };
                },
              }),
            );
          }
          if (queued.includes(runId)) {
            expect(reserve(runId, 8)).toBe(true);
          }
          await registerSubagentRun({
            runId,
            childSessionKey: sessionKey(runId),
            childAgentId: "main",
            sessionEntry: sessions.loadExactSessionEntryReadOnly({
              storePath: childStorePath,
              sessionKey: sessionKey(runId),
            })?.entry,
            requesterSessionKey: parentKey,
            requesterAgentId: "main",
            requesterTurnRunId: parentRunId,
            requesterDisplayKey: parentKey,
            task: runId,
            cleanup: "keep",
            collect: !replaceParent,
            groupId,
            queued: queued.includes(runId),
            expectsCompletionMessage: false,
          });
          if (queued.includes(runId)) {
            swarm.activateSwarmRun({ groupId, runId, start, onStartFailure: () => true });
          }
        }
        if (queued.length === 0) {
          expect(reserve(firstRunId, 1)).toBe(false);
        }
        expect(running.every((runId) => swarm.isSwarmRunActive(runId))).toBe(true);
        for (const runId of queued) {
          expect(swarm.isSwarmRunWaitingForCapacity(runId, runtimeKey(runId))).toBe(true);
        }
        expect(leases).toHaveLength(running.length);
        for (const lease of leases) {
          void lease.released.then(() => {
            releasedLeases.add(lease);
          });
        }
        const activeAdmissionCount = getSessionControllerWorkCount();
        expect(activeAdmissionCount).toBeGreaterThanOrEqual(running.length);
        expect(start).not.toHaveBeenCalled();

        parentTerminal = Promise.allSettled([
          fixture.onceMessage(
            socket,
            (frame) =>
              frame.type === "res" &&
              frame.id === parentRequestId &&
              frame.payload?.status !== "accepted",
          ),
        ]).then(([result]) => result);
        if (replaceParent) {
          const history = await fixture.rpcReq<{
            sessionId: string;
            sessionInfo: { activeLeafEntryId: string | null };
          }>(socket, "chat.history", { sessionKey: parentKey });
          expect(history.ok).toBe(true);
          const payload = expectDefined(history.payload, "parent history");
          expect(payload.sessionId).toBe(parentSessionId);
          expect(payload.sessionInfo).toHaveProperty("activeLeafEntryId");
          fixture.embeddedRunMock.activeIds.add(`${firstRunId}-session`);
          abortResponse = fixture.rpcReq(socket, "chat.send", {
            sessionKey: parentKey,
            message: "/stop",
            sessionId: parentSessionId,
            expectedLeafEntryId: payload.sessionInfo.activeLeafEntryId,
            idempotencyKey: "stop-parent-replaced-during-drain",
          });
        } else {
          abortResponse = fixture.rpcReq(socket, "chat.abort", {
            sessionKey: parentKey,
            agentId: "main",
            runId: parentRunId,
          });
        }
        abortOutcome = Promise.allSettled([abortResponse]).then(([outcome]) => {
          responseSettled = true;
          return expectDefined(outcome, "Stop outcome");
        });
        await awaitGateBeforeSettlement(
          firstInterrupted.promise,
          abortOutcome,
          "chat.abort completed before interrupting its children",
        );
        // No child may make sibling interruption wait for this fixture-owned cleanup.
        await expect.poll(() => interrupted.toSorted(), { timeout: 2_000 }).toEqual(running);
        expect(parent.abortSignal!.aborted).toBe(true);
        expect(slotReleaseResults).toEqual(running.map(() => true));
        expect(releasedLeases.size).toBe(0);
        expect(getSessionControllerWorkCount()).toBeGreaterThanOrEqual(running.length);
        expect(responseSettled).toBe(false);
        expect(start).not.toHaveBeenCalled();
        if (replaceParent) {
          acceptedKillIntent = structuredClone(
            expectDefined(subagentRuns.get(firstRunId)?.killIntent, "accepted child kill intent"),
          );
          sessions.replaceSessionEntrySync(replacementScope, {
            sessionId: replacementScope.sessionId,
            lifecycleRevision: "replacement",
            updatedAt: Date.now(),
          });
          expect(
            sessions.appendTranscriptMessageSync(replacementScope, {
              eventId: "replacement-canary",
              message: { role: "user", content: replacementCanary },
              parentId: null,
            }).ok,
          ).toBe(true);
          replacementBefore = await sessions.loadTranscriptEvents(replacementScope);
          expect(replacementBefore).toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({ content: replacementCanary }),
            }),
          );
        }
        for (const lease of leases.toReversed()) {
          lease.release();
        }
        const outcome = await abortOutcome;
        if (outcome.status === "rejected") {
          throw outcome.reason;
        }
        if (replaceParent) {
          expectResponse(outcome.value, {
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              details: { reason: "active-leaf-changed" },
            },
          });
          expect(fixture.embeddedRunMock.abortCalls).not.toContain(`${firstRunId}-session`);
          expect(fixture.embeddedRunMock.activeIds.has(`${firstRunId}-session`)).toBe(true);
          expect(sessions.loadExactSessionEntryReadOnly(replacementScope)?.entry.sessionId).toBe(
            replacementScope.sessionId,
          );
          expect(await sessions.loadTranscriptEvents(replacementScope)).toEqual(replacementBefore);
        } else if (fault) {
          expectResponse(outcome.value, {
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: expect.stringContaining("synthetic sibling interruption failure"),
            },
          });
        } else {
          expectResponse(outcome.value, {
            ok: true,
            payload: { ok: true, aborted: true, runIds: [parentRunId] },
          });
        }

        if (!fault && !replaceParent) {
          await describe(sessionKey(firstRunId), `${firstRunId}-session`, {
            status: "killed",
            hasActiveRun: false,
          });
          await describe(parentKey, parentSessionId);
        }
        const persistedRuns = listRunsForControllerFromRuns(
          loadSubagentRegistryFromSqlite(),
          parentKey,
        );
        expect(persistedRuns.map((run) => run.runId).toSorted()).toEqual(selected.toSorted());
        for (const run of persistedRuns) {
          const { runId } = run;
          if (replaceParent && run.killIntent) {
            // Bookkeeping may fail after interruption; the exact durable claim remains recoverable.
            expect(run.killIntent).toEqual(acceptedKillIntent);
          } else if (runId === failedRunId) {
            expect(run.execution.status).toBe("running");
            expect(run.execution.endedAt).toBeUndefined();
          } else {
            expect(run).toMatchObject({
              endedReason: "subagent-killed",
              execution: { status: "terminal" },
            });
          }
          if (replaceParent && !run.killIntent) {
            expect(run.killReconciliation).toMatchObject({
              killedAt: expectDefined(acceptedKillIntent, "accepted child kill intent").requestedAt,
              taskCancellationAccepted: true,
            });
          }
          if (queued.includes(runId)) {
            expect(run.execution.startedAt).toBeUndefined();
            expect(swarm.ownsSwarmRunReservation(runId, runtimeKey(runId))).toBe(false);
          }
        }
        expect(start).not.toHaveBeenCalled();
      },
      async () => {
        // Cleanup is unconditional, including the expected pre-fix fanout assertion failure.
        cancellationInspected.resolve();
        await cancellationOwner;
        for (const lease of leases) {
          lease.release();
        }
        const outcome = await abortOutcome;
        if (outcome?.status === "rejected") {
          throw outcome.reason;
        }
      },
      async () => {
        parentFinish.resolve();
        const terminal = await parentTerminal;
        if (terminal?.status === "rejected") {
          throw terminal.reason;
        }
      },
      async () => {
        const reservationReleases: Promise<void>[] = [];
        try {
          for (const runId of selected) {
            if (replaceParent) {
              fixture.embeddedRunMock.activeIds.delete(`${runId}-session`);
            }
            const hold = swarm.holdQueuedSwarmRun(runId);
            if (hold) {
              hold.withdraw();
              reservationReleases.push(hold.release());
            }
            swarm.releaseSwarmRun(runId);
          }
          socket.close();
        } finally {
          await Promise.all(reservationReleases);
        }
        socket.close();
        expect(getSessionMutationCount()).toBe(0);
        expect(getSessionControllerWorkCount()).toBe(0);
      },
    );
  });
}

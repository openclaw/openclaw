import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { listRunsForControllerFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
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
import * as sessionWork from "../sessions/session-lifecycle-admission.js";
import {
  agentCommandMock,
  connectOk,
  createGatewaySuiteHarness,
  embeddedRunMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
} from "./test-helpers.js";

let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    gateway = await createGatewaySuiteHarness();
  },
  cleanup: async () => {
    await runQaGatewayFixture(
      async () => gateway?.close(),
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

for (const { name, fault, replaceParent } of [
  {
    name: "public session creation and child Stop publish readable cancellation state",
    fault: false,
    replaceParent: false,
  },
  {
    name: "chat.abort interrupts all siblings before cleanup and preserves failure accounting",
    fault: true,
    replaceParent: false,
  },
  {
    name: "typed Stop rejects a replaced parent while retaining its accepted child cancellation",
    fault: false,
    replaceParent: true,
  },
]) {
  test(name, async () => {
    const suffix = replaceParent ? "replacement" : fault ? "fault" : "success";
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
    testState.sessionStorePath = storePath;
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
    const leases: sessionWork.SessionWorkAdmissionLease[] = [];
    const interrupted: string[] = [];
    const firstInterrupted = createDeferred();
    const slotReleaseResults: boolean[] = [];
    const start = vi.fn(async () => {});
    let parentRequestId: string | undefined;
    let abortResponse: ReturnType<typeof rpcReq> | undefined;
    let abortOutcome:
      | Promise<
          { ok: true; response: Awaited<ReturnType<typeof rpcReq>> } | { ok: false; error: unknown }
        >
      | undefined;
    let responseSettled = false;
    let acceptedKillIntent: SubagentRunRecord["killIntent"];
    const rpc = <T extends Record<string, unknown>>(
      method: string,
      params: Record<string, unknown>,
    ) => rpcReq<T>(socket, method, params);
    const runtimeKey = (runId: string) => getSubagentRunRuntimeKey(subagentRuns.get(runId)!);
    const describe = async (
      key: string,
      sessionId: string,
      fields: Record<string, unknown> = {},
    ) => {
      const response = await rpc("sessions.describe", { key, agentId: "main" });
      expect(response, JSON.stringify(response.error)).toMatchObject({
        ok: true,
        payload: { session: { key, sessionId, ...fields } },
      });
    };

    await runQaGatewayFixture(
      async () => {
        if (!fault && !replaceParent) {
          await prepareGatewayReplyRuntimeForTest({ force: true });
        }
        await connectOk(socket, {
          scopes: ["operator.read", "operator.write"],
          prePairDevice: true,
        });
        if (!fault && !replaceParent) {
          const created = await rpc<{ key: string; sessionId: string }>("sessions.create", {
            agentId: "main",
            key: parentKey,
          });
          expect(created, JSON.stringify(created.error)).toMatchObject({
            ok: true,
            payload: { key: parentKey },
          });
          parentSessionId = expectDefined(created.payload, "created non-main parent").sessionId;
          expect(parentSessionId).not.toBe("");
        }
        agentCommandMock.mockImplementationOnce(async (input) => {
          const command = input as AgentCommandOpts;
          expect(command.abortSignal).toBeInstanceOf(AbortSignal);
          await command.onExecutionStarted?.();
          parentStarted.resolve(command);
          await parentFinish.promise;
          command.abortSignal!.throwIfAborted();
        });
        const accepted = await rpc("agent", {
          sessionKey: parentKey,
          message: "Keep this synthetic parent active until Stop",
          idempotencyKey: parentRunId,
        });
        parentRequestId = accepted.id;
        expect(accepted).toMatchObject({
          ok: true,
          payload: { runId: parentRunId, status: "accepted" },
        });
        const parent = await parentStarted.promise;
        expect(agentCommandMock).toHaveBeenCalledTimes(1);

        for (const runId of selected) {
          const childStorePath = await seedSession(sessionKey(runId), `${runId}-session`);
          if (running.includes(runId)) {
            // Recovery must observe the live owner when the run is registered.
            leases.push(
              await sessionWork.beginSessionWorkAdmission({
                scope: storePath,
                identities: [sessionKey(runId), `${runId}-session`],
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
            expect(
              swarm.reserveSwarmRun({ groupId, runId, maxConcurrent: 8, activeRunIds: running }),
            ).toBe(true);
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
          expect(
            swarm.reserveSwarmRun({
              groupId,
              runId: firstRunId,
              maxConcurrent: 1,
              activeRunIds: running,
            }),
          ).toBe(false);
        }
        expect(running.every((runId) => swarm.isSwarmRunActive(runId))).toBe(true);
        for (const runId of queued) {
          expect(swarm.isSwarmRunWaitingForCapacity(runId, runtimeKey(runId))).toBe(true);
        }
        const activeAdmissionCount = sessionWork.getActiveSessionWorkAdmissionCount();
        expect(activeAdmissionCount).toBeGreaterThanOrEqual(running.length);
        expect(start).not.toHaveBeenCalled();

        if (replaceParent) {
          const history = await rpc<{
            sessionId: string;
            sessionInfo: { activeLeafEntryId: string | null };
          }>("chat.history", { sessionKey: parentKey });
          expect(history.ok).toBe(true);
          const payload = expectDefined(history.payload, "parent history");
          expect(payload.sessionId).toBe(parentSessionId);
          expect(payload.sessionInfo).toHaveProperty("activeLeafEntryId");
          embeddedRunMock.activeIds.add(`${firstRunId}-session`);
          abortResponse = rpc("chat.send", {
            sessionKey: parentKey,
            message: "/stop",
            sessionId: parentSessionId,
            expectedLeafEntryId: payload.sessionInfo.activeLeafEntryId,
            idempotencyKey: "stop-parent-replaced-during-drain",
          });
        } else {
          abortResponse = rpc("chat.abort", {
            sessionKey: parentKey,
            agentId: "main",
            runId: parentRunId,
          });
        }
        abortOutcome = abortResponse.then(
          (response) => {
            responseSettled = true;
            return { ok: true as const, response };
          },
          (error: unknown) => {
            responseSettled = true;
            return { ok: false as const, error };
          },
        );
        await awaitGateBeforeSettlement(
          firstInterrupted.promise,
          abortOutcome,
          "chat.abort completed before interrupting its children",
        );
        // No child may make sibling interruption wait for this fixture-owned cleanup.
        await expect.poll(() => interrupted.toSorted(), { timeout: 2_000 }).toEqual(running);
        expect(parent.abortSignal!.aborted).toBe(true);
        expect(slotReleaseResults).toEqual(running.map(() => true));
        expect(leases.every((lease) => lease.isActive())).toBe(true);
        expect(sessionWork.getActiveSessionWorkAdmissionCount()).toBe(activeAdmissionCount);
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
        if (!outcome.ok) {
          throw outcome.error;
        }
        if (replaceParent) {
          expect(outcome.response).toMatchObject({
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              details: {
                code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
                method: "chat.send",
                sessionKey: parentKey,
              },
            },
          });
          expect(embeddedRunMock.abortCalls).not.toContain(`${firstRunId}-session`);
          expect(embeddedRunMock.activeIds.has(`${firstRunId}-session`)).toBe(true);
          expect(sessions.loadExactSessionEntryReadOnly(replacementScope)?.entry.sessionId).toBe(
            replacementScope.sessionId,
          );
          expect(await sessions.loadTranscriptEvents(replacementScope)).toEqual(replacementBefore);
        } else if (fault) {
          expect(outcome.response).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
          expect(outcome.response.error?.message).toContain(
            "synthetic sibling interruption failure",
          );
        } else {
          expect(outcome.response).toMatchObject({
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
        for (const lease of leases) {
          lease.release();
        }
        const outcome = await abortOutcome;
        if (outcome && !outcome.ok) {
          throw outcome.error;
        }
      },
      async () => {
        const terminal = parentRequestId
          ? onceMessage(
              socket,
              (frame) =>
                frame.type === "res" &&
                frame.id === parentRequestId &&
                frame.payload?.status !== "accepted",
            )
          : undefined;
        parentFinish.resolve();
        await terminal;
      },
      async () => {
        const reservationReleases: Promise<void>[] = [];
        try {
          for (const runId of selected) {
            if (replaceParent) {
              embeddedRunMock.activeIds.delete(`${runId}-session`);
            }
            const hold = swarm.holdQueuedSwarmRun(runId);
            if (hold) {
              hold.withdraw();
              reservationReleases.push(hold.release());
            }
            swarm.releaseSwarmRun(runId);
          }
          socket.close();
          expect(sessionWork.getActiveSessionLifecycleMutationCount()).toBe(0);
          expect(sessionWork.getActiveSessionWorkAdmissionCount()).toBe(0);
        } finally {
          await Promise.all(reservationReleases);
        }
      },
    );
  });
}

import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRunsForControllerFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  activateSwarmRun,
  isSwarmRunActive,
  isSwarmRunWaitingForCapacity,
  ownsSwarmRunReservation,
  releaseSwarmRun,
  removeQueuedSwarmRun,
  reserveSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../agents/subagents/swarm/swarm-scheduler.test-support.js";
import {
  appendTranscriptMessageSync,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
  type SessionWorkAdmissionLease,
} from "../sessions/session-lifecycle-admission.js";
import {
  agentCommandMock,
  connectOk,
  createGatewaySuiteHarness,
  embeddedRunMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
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
        resetSubagentRegistryForTests({ persist: false });
        schedulerTesting.reset();
      },
    );
  },
});

await import("./server.js");

for (const { name, fault, replaceParent } of [
  ...[false, true].map((faultCase) => ({
    name: `chat.abort interrupts all siblings before cleanup and preserves failure accounting (fault=${faultCase})`,
    fault: faultCase,
    replaceParent: false,
  })),
  {
    name: "typed Stop rejects a replaced parent while child cancellation drains",
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
      { length: replaceParent ? 1 : 8 },
      (_, index) => `running-${suffix}-${index}`,
    );
    const firstRunId = expectDefined(running[0], "first running child");
    const queued = replaceParent ? [] : [`queued-${suffix}-0`, `queued-${suffix}-1`];
    const selected = [...running, ...queued];
    const failedRunId = fault ? running[3] : undefined;
    const sessionKey = (runId: string) => `agent:main:subagent:${runId}`;
    const stateDir = process.env.OPENCLAW_STATE_DIR!;
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const parentSessionId = `parent-session-${suffix}`;
    const replacementScope = {
      storePath,
      agentId: "main",
      sessionKey: parentKey,
      sessionId: `replacement-session-${suffix}`,
    };
    const replacementCanary = "The replacement conversation must survive the earlier Stop.";
    let replacementBefore: Awaited<ReturnType<typeof loadTranscriptEvents>> | undefined;
    testState.sessionStorePath = storePath;
    await writeSessionStore({
      entries: { [parentKey]: { sessionId: parentSessionId, updatedAt: Date.now() } },
    });

    const socket = await gateway.openWs();
    const parentStarted = createDeferred<AgentCommandOpts>();
    const parentFinish = createDeferred();
    const leases: SessionWorkAdmissionLease[] = [];
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

    await runQaGatewayFixture(
      async () => {
        await connectOk(socket, {
          scopes: ["operator.read", "operator.write"],
          prePairDevice: true,
        });
        agentCommandMock.mockImplementationOnce(async (input) => {
          const command = input as AgentCommandOpts;
          expect(command.abortSignal).toBeInstanceOf(AbortSignal);
          await command.onExecutionStarted?.();
          parentStarted.resolve(command);
          await parentFinish.promise;
          command.abortSignal!.throwIfAborted();
        });
        const accepted = await rpcReq(socket, "agent", {
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
          await writeSubagentSessionEntry({
            stateDir,
            agentId: "main",
            sessionKey: sessionKey(runId),
            defaultSessionId: `${runId}-session`,
          });
          if (queued.includes(runId)) {
            expect(
              reserveSwarmRun({ groupId, runId, maxConcurrent: 8, activeRunIds: running }),
            ).toBe(true);
          }
          await registerSubagentRun({
            runId,
            childSessionKey: sessionKey(runId),
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
            activateSwarmRun({ groupId, runId, start, onStartFailure: () => true });
          }
        }
        if (replaceParent) {
          expect(
            reserveSwarmRun({
              groupId,
              runId: firstRunId,
              maxConcurrent: 1,
              activeRunIds: running,
            }),
          ).toBe(false);
        }
        for (const runId of running) {
          expect(isSwarmRunActive(runId)).toBe(true);
          leases.push(
            await beginSessionWorkAdmission({
              scope: storePath,
              identities: [sessionKey(runId), `${runId}-session`],
              assertAllowed: () => {},
              onInterrupt: () => {
                interrupted.push(runId);
                firstInterrupted.resolve();
                slotReleaseResults.push(releaseSwarmRun(runId));
                if (runId === failedRunId) {
                  throw new Error("synthetic sibling interruption failure");
                }
              },
            }),
          );
        }
        for (const runId of queued) {
          expect(isSwarmRunWaitingForCapacity(runId, subagentRuns.get(runId)!)).toBe(true);
        }
        const activeAdmissionCount = getActiveSessionWorkAdmissionCount();
        expect(activeAdmissionCount).toBeGreaterThanOrEqual(running.length);
        expect(start).not.toHaveBeenCalled();

        if (replaceParent) {
          const history = await rpcReq<{
            sessionId: string;
            sessionInfo: { activeLeafEntryId: string | null };
          }>(socket, "chat.history", { sessionKey: parentKey });
          expect(history.ok).toBe(true);
          const payload = expectDefined(history.payload, "parent history");
          expect(payload.sessionId).toBe(parentSessionId);
          expect(payload.sessionInfo).toHaveProperty("activeLeafEntryId");
          embeddedRunMock.activeIds.add(`${firstRunId}-session`);
          abortResponse = rpcReq(socket, "chat.send", {
            sessionKey: parentKey,
            message: "/stop",
            sessionId: parentSessionId,
            expectedLeafEntryId: payload.sessionInfo.activeLeafEntryId,
            idempotencyKey: "stop-parent-replaced-during-drain",
          });
        } else {
          abortResponse = rpcReq(socket, "chat.abort", {
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
        await Promise.race([
          firstInterrupted.promise,
          abortOutcome.then(() => {
            throw new Error("chat.abort completed before interrupting its children");
          }),
        ]);
        // No child may make sibling interruption wait for this fixture-owned cleanup.
        await expect.poll(() => interrupted.toSorted(), { timeout: 2_000 }).toEqual(running);
        expect(parent.abortSignal!.aborted).toBe(true);
        expect(slotReleaseResults).toEqual(running.map(() => true));
        expect(leases.every((lease) => lease.isActive())).toBe(true);
        expect(getActiveSessionWorkAdmissionCount()).toBe(activeAdmissionCount);
        expect(responseSettled).toBe(false);
        expect(start).not.toHaveBeenCalled();
        if (replaceParent) {
          expect(subagentRuns.get(firstRunId)?.killIntent).toBeDefined();
          replaceSessionEntrySync(replacementScope, {
            sessionId: replacementScope.sessionId,
            lifecycleRevision: "replacement",
            updatedAt: Date.now(),
          });
          expect(
            appendTranscriptMessageSync(replacementScope, {
              eventId: "replacement-canary",
              message: { role: "user", content: replacementCanary },
              parentId: null,
            }).ok,
          ).toBe(true);
          replacementBefore = await loadTranscriptEvents(replacementScope);
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
          expect(loadExactSessionEntryReadOnly(replacementScope)?.entry.sessionId).toBe(
            replacementScope.sessionId,
          );
          expect(await loadTranscriptEvents(replacementScope)).toEqual(replacementBefore);
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

        const persistedRuns = new Map(
          loadSubagentRunsForControllerFromSqlite(parentKey).map((run) => [run.runId, run]),
        );
        expect([...persistedRuns.keys()].toSorted()).toEqual(selected.toSorted());
        for (const runId of selected) {
          const run = persistedRuns.get(runId)!;
          if (replaceParent || runId === failedRunId) {
            expect(run.execution.status).toBe("running");
            expect(run.execution.endedAt).toBeUndefined();
          } else {
            expect(run).toMatchObject({
              endedReason: "subagent-killed",
              execution: { status: "terminal" },
            });
          }
          if (replaceParent) {
            expect(run.killIntent).toBeUndefined();
            expect(
              loadExactSessionEntryReadOnly({ storePath, sessionKey: sessionKey(runId) })?.entry
                .abortedLastRun,
            ).not.toBe(true);
          }
          if (queued.includes(runId)) {
            expect(run.execution.startedAt).toBeUndefined();
            expect(ownsSwarmRunReservation(runId, subagentRuns.get(runId)!)).toBe(false);
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
      () => {
        for (const runId of selected) {
          if (replaceParent) {
            embeddedRunMock.activeIds.delete(`${runId}-session`);
          }
          removeQueuedSwarmRun(runId);
          releaseSwarmRun(runId);
        }
        socket.close();
        expect(getActiveSessionLifecycleMutationCount()).toBe(0);
        expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      },
    );
  });
}

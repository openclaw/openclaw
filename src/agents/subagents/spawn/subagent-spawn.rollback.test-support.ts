import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  removeChatAbortControllerEntry,
  type ChatAbortControllerEntry,
} from "../../../gateway/chat-abort.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { prepareGatewayRunShutdown } from "../../../gateway/server-run-shutdown.js";
import { withTimeout } from "../../../infra/fs-safe.js";
import type { SqliteWorkerCommand } from "../../../infra/sqlite-worker-contract.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../../../state/openclaw-state-worker-contract.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import {
  createOperationalRunInstanceRef,
  type AdmittedRunOperatorAuthority,
} from "../../admitted-run-context.js";
import { reserveChildAdmissionSlot, resolveChildAdmission } from "../../child-admission.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "../registry/subagent-registry-persistence.js";
import { settleSubagentRegistryPersistenceWork } from "../registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import {
  createBoundSpawnInvocation,
  createSpawnOperatorSource,
  type createSpawnBoundaryParent,
} from "./subagent-spawn.production-boundary.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
type GatewayRuntime = ReturnType<typeof createGatewayInstanceRuntime>;
type RegistryWrite = Extract<
  SqliteWorkerCommand<OpenClawStateWorkerOperations>,
  { type: "subagents.persistChanges" }
>;

function interceptChildRegistrationWrite(
  requesterSessionKey: string,
  fail: (
    row: RegistryWrite["input"]["values"][number],
    context: OpenClawStateWorkerContext,
  ) => Promise<never>,
) {
  const failure = vi.fn(fail);
  const runWorkerOperation = stateWorker.runOpenClawStateWorkerOperation;
  let intercepted = false;
  const spy = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((workerContext, operation, workerOptions) =>
      runWorkerOperation(
        workerContext,
        (scope) =>
          operation({
            execute: vi
              .fn()
              .mockImplementation(
                async (command: SqliteWorkerCommand<OpenClawStateWorkerOperations>) => {
                  const row =
                    !intercepted && command.type === "subagents.persistChanges"
                      ? command.input.values.find(
                          (entry) => entry.requester_session_key === requesterSessionKey,
                        )
                      : undefined;
                  if (!row) {
                    return scope.execute(command);
                  }
                  intercepted = true;
                  return failure(row, workerContext);
                },
              ),
          }),
        workerOptions,
      ),
    );
  return { failure, restore: () => spy.mockRestore() };
}

export function registerOperatorSpawnRollbackCases(options: {
  createBoundParent: (
    authority?: AdmittedRunOperatorAuthority,
    settings?: { maxChildrenPerAgent?: number; guestProfileId?: string },
  ) => Promise<BoundParent>;
  createBoundGateway: (bound: BoundParent) => Promise<{
    context: GatewayRequestContext;
    runtime: GatewayRuntime;
  }>;
  closeBoundGateway: (
    bound: BoundParent,
    runtime: GatewayRuntime,
    childRunId?: string,
  ) => Promise<unknown[]>;
  throwBoundFailures: (failures: unknown[]) => void;
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>;
}) {
  it.each([
    { phase: "preparation", label: "revoked-source preparation", scope: "operator.write" },
    {
      phase: "accepted registration",
      label: "revoked-source accepted registration",
      scope: "operator.write",
    },
    { phase: "uncertain registration", label: "uncertain registration", scope: "operator.write" },
    {
      phase: "accepted registration",
      label: "guest revoked-source accepted registration",
      scope: "operator.sessions.write",
    },
  ] as const)(
    "rolls back an ordinary operator spawn and joins cleanup after $label failure",
    async ({ phase, scope: operatorScope }) => {
      const guest = operatorScope === "operator.sessions.write";
      const source = createSpawnOperatorSource(
        guest ? ensureProfileForEmail("rollback-guest@example.test").id : "spawn-operator",
        [operatorScope],
      );
      const bound = await options.createBoundParent(source.authority, {
        guestProfileId: guest ? source.authority.profileId : undefined,
      });
      const { context, runtime } = await options.createBoundGateway(bound);
      const preserveSession = phase === "uncertain registration";
      let childSessionKey: string | undefined;
      let childRunId: string | undefined;
      let embeddedSignal: AbortSignal | undefined;
      let embeddedSettled = false;
      const embeddedStarted = createDeferred();
      let invocation: Promise<unknown> | undefined;
      let registrationUncertain = false;
      let registrationWrite: ReturnType<typeof interceptChildRegistrationWrite> | undefined;
      let retainedChildIdentity: { sessionId: string; lifecycleRevision?: string } | undefined;
      const cleanupAttemptSettled = createDeferred();
      const dispatchSessionMethod = runtime.recovery.dispatchSessionMethod;
      const cleanupDispatch = preserveSession
        ? vi
            .spyOn(runtime.recovery, "dispatchSessionMethod")
            .mockImplementation(async (...args) => {
              try {
                return await dispatchSessionMethod(...args);
              } finally {
                cleanupAttemptSettled.resolve();
              }
            })
        : undefined;
      const failures: unknown[] = [];
      if (phase === "preparation") {
        spawnTesting.setDepsForTest({
          forkSessionEntryFromParent: async (params) => {
            childSessionKey = params.sessionKey;
            source.revoke();
            return { status: "failed" };
          },
        });
      } else {
        options.runEmbeddedAgent.mockImplementationOnce(async (params) => {
          const signal = expectDefined(params.abortSignal, "accepted child abort signal");
          embeddedSignal = signal;
          embeddedStarted.resolve();
          try {
            return await new Promise<never>((_resolve, reject) => {
              const abort = () =>
                reject(toErrorObject(signal.reason, "Accepted child execution aborted"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) {
                signal.removeEventListener("abort", abort);
                abort();
              }
            });
          } finally {
            embeddedSettled = true;
          }
        });
        registrationWrite = interceptChildRegistrationWrite(
          bound.parentSessionKey,
          async (record) => {
            childSessionKey = record.child_session_key;
            childRunId = record.run_id;
            expect(subagentRuns.has(record.run_id)).toBe(false);
            const acceptedRun = expectDefined(
              context.chatAbortControllers.get(record.run_id),
              "accepted child execution owner",
            );
            expect(acceptedRun.sessionKey).toBe(record.child_session_key);
            if (phase === "uncertain registration") {
              await embeddedStarted.promise;
              expect(expectDefined(embeddedSignal, "running child abort signal").aborted).toBe(
                false,
              );
              expect(context.chatAbortControllers.get(record.run_id)).toBe(acceptedRun);
              const childEntry = expectDefined(
                loadSessionEntry({
                  storePath: bound.storePath,
                  sessionKey: record.child_session_key,
                }),
                "uncertain registration child session",
              );
              retainedChildIdentity = {
                sessionId: childEntry.sessionId,
                lifecycleRevision: childEntry.lifecycleRevision,
              };
              expect(acceptedRun).toMatchObject({
                sessionKey: record.child_session_key,
                sessionId: childEntry.sessionId,
              });
              registrationUncertain = true;
            }
            if (phase === "accepted registration") {
              source.revoke();
            }
            throw new SubagentRegistryWriteError(
              phase === "uncertain registration" ? "unknown" : "not-committed",
              new Error("ordinary child registry write failed"),
            );
          },
        );
      }
      try {
        const pending = createBoundSpawnInvocation(bound, {
          context: phase === "preparation" ? "fork" : "isolated",
        })();
        invocation = pending;
        const completion = preserveSession
          ? (async () => {
              await Promise.race([cleanupAttemptSettled.promise, pending]);
              const childKey = expectDefined(childSessionKey, "registered child session");
              const runId = expectDefined(childRunId, "registered child run");
              const dispatch = expectDefined(cleanupDispatch, "bound cleanup dispatch observer");
              source.authority.assertCurrent();
              expect(expectDefined(embeddedSignal, "accepted child abort signal").aborted).toBe(
                true,
              );
              expect(dispatch).toHaveBeenCalledWith(
                "chat.abort",
                { sessionKey: childKey, runId },
                expect.objectContaining({ assertCurrent: expect.any(Function) }),
              );
              const result = await pending;
              await bound.execution.drain();
              return result;
            })()
          : pending;
        const result = await withTimeout(completion, 60_000, {
          message: "ordinary spawn rollback cleanup did not settle",
        });
        const childKey = expectDefined(childSessionKey, "created child session");
        expect(result.details).toMatchObject({ status: "error", childSessionKey: childKey });
        if (preserveSession) {
          expect(registrationUncertain).toBe(phase === "uncertain registration");
          const dispatch = expectDefined(cleanupDispatch, "bound cleanup dispatch observer");
          expect(dispatch.mock.calls.some(([method]) => method === "sessions.delete")).toBe(false);
          expect(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: childKey }),
          ).toMatchObject(expectDefined(retainedChildIdentity, "original retained child identity"));
          expect(options.runEmbeddedAgent).toHaveBeenCalledOnce();
          expect(embeddedSignal).toBeDefined();
          if (phase === "uncertain registration") {
            expect(registrationWrite?.failure).toHaveBeenCalledOnce();
          }
        } else {
          expect(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: childKey }),
          ).toBeUndefined();
        }
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: bound.parentSessionKey }),
        ).toMatchObject({ sessionId: "parent-session" });
        if (phase === "preparation") {
          expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
        } else {
          const runId = expectDefined(childRunId, "accepted child run");
          expect(context.chatAbortControllers.has(runId)).toBe(false);
          expect(context.dedupe.get(`agent:${runId}`)).toMatchObject({
            payload: { runId, status: expect.stringMatching(/^(error|timeout)$/) },
          });
          expect(subagentRuns.has(runId)).toBe(false);
          if (embeddedSignal) {
            expect(embeddedSignal.aborted).toBe(true);
            expect(embeddedSettled).toBe(true);
          } else {
            expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
          }
        }
      } catch (error) {
        failures.push(error);
      } finally {
        embeddedStarted.resolve();
        spawnTesting.setDepsForTest();
        registrationWrite?.restore();
        for (const entry of context.chatAbortControllers.values()) {
          if (entry !== bound.parent.entry) {
            entry.controller.abort(new Error("spawn rollback fixture cleanup"));
          }
        }
        if (preserveSession) {
          await invocation?.catch(() => {});
        }
        failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
        if (preserveSession) {
          try {
            await settleSubagentRegistryPersistenceWork();
          } catch (error) {
            failures.push(error);
          }
        }
        cleanupDispatch?.mockRestore();
        try {
          await resetSubagentRegistryForTests({ persist: false });
          expect(source.holds).toBe(0);
        } catch (error) {
          failures.push(error);
        }
        options.throwBoundFailures(failures);
      }
    },
  );

  it.each([
    { label: "operator retry", operator: true, transition: "retry" },
    { label: "non-operator retry", operator: false, transition: "retry" },
    {
      label: "non-operator database retirement",
      operator: false,
      transition: "database-retirement",
    },
    { label: "non-operator controller reassignment", operator: false, transition: "reassign" },
    { label: "operator Gateway shutdown", operator: true, transition: "shutdown" },
  ] as const)(
    "returns an uncertain registration error while retaining cleanup for $label",
    async ({ operator, transition }) => {
      const source = operator ? createSpawnOperatorSource() : undefined;
      const bound = await options.createBoundParent(source?.authority, { maxChildrenPerAgent: 1 });
      const { context, runtime } = await options.createBoundGateway(bound);
      const embeddedStarted = createDeferred();
      const retryEntered = createDeferred();
      const releaseRetry = createDeferred();
      const retrySettled = createDeferred();
      const cleanupStopped = createDeferred();
      let registrationAdmission: OpenClawStateWorkerContext["admission"] | undefined;
      const invocations: Promise<unknown>[] = [];
      const failures: unknown[] = [];
      const registrationFailure = new SubagentRegistryWriteError(
        "unknown",
        new Error("ordinary child registry outcome is unknown"),
      );
      let child:
        | {
            runId: string;
            sessionKey: string;
            entry: ChatAbortControllerEntry;
            sessionIdentity: { sessionId: string; lifecycleRevision?: string };
          }
        | undefined;
      let replacement: ChatAbortControllerEntry | undefined;
      let embeddedSignal: AbortSignal | undefined;
      let embeddedSettled = false;
      let retrySignal: AbortSignal | undefined;
      let abortAttempts = 0;
      let reachedRealRetry = false;
      const dispatchSessionMethod = runtime.recovery.dispatchSessionMethod;
      const cleanupWarning = vi.spyOn(context.logGateway, "warn").mockImplementation((message) => {
        if (message.includes("termination remains unconfirmed")) {
          cleanupStopped.resolve();
        }
      });
      const shutdownGateway = async () => {
        bound.execution.beginClose();
        runtime.close();
        await prepareGatewayRunShutdown({
          resolveGatewayContext: () => bound.gatewayBinding.current,
          chatAbortControllers: context.chatAbortControllers,
          chatQueuedTurns: context.chatQueuedTurns,
          chatRunState: context.chatRunState,
          removeChatRun: context.removeChatRun,
          agentRunSeq: context.agentRunSeq,
          broadcast: context.broadcast,
          nodeSendToSession: context.nodeSendToSession,
          restart: false,
          getPendingReplyCount: () => 0,
          timeoutMs: 0,
          warnings: [],
        });
      };
      const cleanupDispatch = vi
        .spyOn(runtime.recovery, "dispatchSessionMethod")
        .mockImplementation(async (...args) => {
          if (args[0] !== "chat.abort") {
            return await dispatchSessionMethod(...args);
          }
          abortAttempts += 1;
          if (abortAttempts === 1) {
            throw new Error("first accepted-child abort failed");
          }
          if (abortAttempts === 2) {
            retrySignal = args[2]?.signal;
            retryEntered.resolve();
            try {
              await releaseRetry.promise;
              reachedRealRetry = true;
              return await dispatchSessionMethod(...args);
            } finally {
              retrySettled.resolve();
            }
          }
          return await dispatchSessionMethod(...args);
        });
      options.runEmbeddedAgent.mockImplementationOnce(async (params) => {
        const signal = expectDefined(params.abortSignal, "accepted child abort signal");
        embeddedSignal = signal;
        embeddedStarted.resolve();
        try {
          return await new Promise<never>((_resolve, reject) => {
            const abort = () =>
              reject(toErrorObject(signal.reason, "Accepted child execution aborted"));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
              signal.removeEventListener("abort", abort);
              abort();
            }
          });
        } finally {
          embeddedSettled = true;
        }
      });
      const registrationWrite = interceptChildRegistrationWrite(
        bound.parentSessionKey,
        async (record, workerContext) => {
          registrationAdmission = workerContext.admission;
          const entry = expectDefined(
            context.chatAbortControllers.get(record.run_id),
            "accepted child execution owner",
          );
          const session = expectDefined(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: record.child_session_key }),
            "uncertain registration child session",
          );
          child = {
            runId: record.run_id,
            sessionKey: record.child_session_key,
            entry,
            sessionIdentity: {
              sessionId: session.sessionId,
              lifecycleRevision: session.lifecycleRevision,
            },
          };
          await embeddedStarted.promise;
          throw registrationFailure;
        },
      );
      try {
        const invoke = createBoundSpawnInvocation(bound, { context: "isolated" });
        const pending = invoke("uncertain-registration");
        invocations.push(pending);
        const [, result] = await withTimeout(Promise.all([retryEntered.promise, pending]), 60_000, {
          message: "registration failure waited for the held accepted-child cleanup",
        });
        const accepted = expectDefined(child, "accepted child before registration failure");
        const signal = expectDefined(embeddedSignal, "running accepted child");
        const details = expectDefined(asOptionalRecord(result.details), "spawn failure details");
        expect(details).toMatchObject({
          status: "error",
          childSessionKey: accepted.sessionKey,
          runId: accepted.runId,
        });
        expect(details.error).toContain(registrationFailure.message);
        expect(details.error).toContain("termination is not confirmed");
        expect(details.error).toContain("cleanup is pending");
        expect(reachedRealRetry).toBe(false);
        expect(retrySignal).toBe(bound.execution.signal);
        expect(retrySignal?.aborted).toBe(false);
        expect(signal.aborted).toBe(false);
        expect(embeddedSettled).toBe(false);
        expect(context.chatAbortControllers.get(accepted.runId)).toBe(accepted.entry);
        expect(subagentRuns.has(accepted.runId)).toBe(false);

        const otherSpawn = invoke("capacity-during-uncertain-cleanup");
        invocations.push(otherSpawn);
        const blocked = await otherSpawn;
        expect(blocked.details).toMatchObject({
          status: "forbidden",
          error: expect.stringContaining("max active children"),
        });
        expect(options.runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(registrationWrite.failure).toHaveBeenCalledOnce();

        if (transition === "reassign") {
          replacement = {
            ...accepted.entry,
            controller: new AbortController(),
            operationalRunInstance: createOperationalRunInstanceRef(accepted.runId),
            agentRunDelegatedAuthority: undefined,
          };
          expect(replacement.operationalRunInstance).not.toBe(
            accepted.entry.operationalRunInstance,
          );
          context.chatAbortControllers.set(accepted.runId, replacement);
        } else if (transition === "database-retirement") {
          const admission = expectDefined(registrationAdmission, "registration database admission");
          await closeOpenClawStateDatabaseByPathAsync(admission.databasePath);
          expect(admission.assertCurrent).toThrow(/admission/);
          const current = captureOpenClawStateWorkerContext().admission;
          expect(current).not.toBe(admission);
          expect(current.identity.key).toBe(admission.identity.key);
          expect(current.assertCurrent).not.toThrow();
          expect(runtime.isAvailable()).toBe(true);
          expect(context.chatAbortControllers.get(accepted.runId)).toBe(accepted.entry);
          expect(signal.aborted).toBe(false);
          expect(retrySignal?.aborted).toBe(false);
        } else if (transition === "shutdown") {
          await shutdownGateway();
          expect(retrySignal?.aborted).toBe(true);
          expect(signal.aborted).toBe(true);
        } else if (source) {
          // Source revocation has its own cancellation owner; only the non-operator
          // row proves that this retry itself stops the accepted child.
          source.revoke();
          expect(() => source.authority.assertCurrent()).toThrow("operator source revoked");
          expect(retrySignal?.aborted).toBe(false);
        }
        releaseRetry.resolve();
        await retrySettled.promise;
        expect(reachedRealRetry).toBe(true);
        if (transition === "database-retirement") {
          await cleanupStopped.promise;
          const nextSpawn = invoke("capacity-after-database-retirement");
          invocations.push(nextSpawn);
          expect((await nextSpawn).details).toMatchObject({
            status: "forbidden",
            error: expect.stringContaining("max active children"),
          });
          expect(context.chatAbortControllers.get(accepted.runId)).toBe(accepted.entry);
          expect(signal.aborted).toBe(false);
          expect(embeddedSettled).toBe(false);
          expect(retrySignal?.aborted).toBe(false);
          expect(subagentRuns.has(accepted.runId)).toBe(false);
          await shutdownGateway();
          expect(retrySignal?.aborted).toBe(true);
        }
        if (replacement) {
          expect(context.chatAbortControllers.get(accepted.runId)).toBe(replacement);
          expect(replacement.controller.signal.aborted).toBe(false);
          expect(signal.aborted).toBe(false);
          // The displaced synthetic producer is ours; the successor remains untouched.
          accepted.entry.controller.abort(new Error("reassigned fixture producer cleanup"));
        }
        await AsyncWorkScope.runWhenAllIdle(
          () => [bound.execution],
          () => {},
        );
        expect(signal.aborted).toBe(true);
        expect(embeddedSettled).toBe(true);
        expect(abortAttempts).toBe(2);
        if (replacement) {
          expect(context.chatAbortControllers.get(accepted.runId)).toBe(replacement);
          expect(replacement.controller.signal.aborted).toBe(false);
        } else {
          expect(context.chatAbortControllers.has(accepted.runId)).toBe(false);
        }
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: accepted.sessionKey }),
        ).toMatchObject(accepted.sessionIdentity);
        expect(cleanupDispatch.mock.calls.some(([method]) => method === "sessions.delete")).toBe(
          false,
        );
        const available = reserveChildAdmissionSlot({
          controllerSessionKey: bound.parentSessionKey,
          resolveAdmission: (pendingChildren) =>
            resolveChildAdmission({
              collect: false,
              callerDepth: 0,
              maxSpawnDepth: 2,
              activeChildren: pendingChildren,
              maxActiveChildren: 1,
            }),
        });
        try {
          expect(available.ok).toBe(true);
        } finally {
          if (available.ok) {
            available.release();
          }
        }
      } catch (error) {
        failures.push(error);
      } finally {
        embeddedStarted.resolve();
        releaseRetry.resolve();
        child?.entry.controller.abort(new Error("uncertain spawn fixture cleanup"));
        for (const entry of context.chatAbortControllers.values()) {
          if (entry !== bound.parent.entry && entry !== replacement) {
            entry.controller.abort(new Error("uncertain spawn fixture cleanup"));
          }
        }
        if (child && replacement) {
          removeChatAbortControllerEntry(context.chatAbortControllers, child.runId, replacement);
        }
        registrationWrite.restore();
        const settled = await Promise.allSettled(invocations);
        failures.push(
          ...settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        );
        failures.push(...(await options.closeBoundGateway(bound, runtime, child?.runId)));
        try {
          await settleSubagentRegistryPersistenceWork();
        } catch (error) {
          failures.push(error);
        }
        cleanupDispatch.mockRestore();
        cleanupWarning.mockRestore();
        try {
          await resetSubagentRegistryForTests({ persist: false });
          expect(source?.holds ?? 0).toBe(0);
        } catch (error) {
          failures.push(error);
        }
        options.throwBoundFailures(failures);
      }
    },
  );
}

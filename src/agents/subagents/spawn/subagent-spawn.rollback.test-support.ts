import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { prepareGatewayRunShutdown } from "../../../gateway/server-run-shutdown.js";
import { withTimeout } from "../../../infra/fs-safe.js";
import type { SqliteWorkerCommand } from "../../../infra/sqlite-worker-contract.js";
import {
  getRpcSourceIdentity,
  requestRpcSourceCancellation,
  type RpcSourceRef,
} from "../../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../../../state/openclaw-state-worker-contract.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import type { AdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "../registry/subagent-registry-persistence.js";
import { settleSubagentRegistryPersistenceWork } from "../registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import {
  collectFailure,
  sessionReader,
  type BoundaryHarness,
} from "./subagent-spawn.fixtures.test-support.js";
import {
  createBoundSpawnInvocation,
  createSpawnOperatorSource,
  type createSpawnBoundaryParent,
} from "./subagent-spawn.production-boundary.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
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

function abortableChild(runEmbeddedAgent: BoundaryHarness["runEmbeddedAgent"]) {
  const started = createDeferred();
  const state: { signal?: AbortSignal; settled: boolean } = { settled: false };
  runEmbeddedAgent.mockImplementationOnce(async (params) => {
    const signal = expectDefined(params.abortSignal, "accepted child abort signal");
    state.signal = signal;
    started.resolve();
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
      state.settled = true;
    }
  });
  return { started, state };
}

function cancelFixtureChildren(bound: BoundParent, message: string) {
  for (const entry of rpcSourceTesting.values()) {
    if (entry !== bound.parent.entry) {
      requestRpcSourceCancellation(entry, new Error(message));
    }
  }
}

export function registerOperatorSpawnRollbackCases(
  options: BoundaryHarness & {
    createBoundParent: (
      authority?: AdmittedRunOperatorAuthority,
      settings?: { maxChildrenPerAgent?: number; guestProfileId?: string },
    ) => Promise<BoundParent>;
  },
) {
  it.each([
    { phase: "preparation", actor: "operator" },
    { phase: "accepted registration", actor: "operator" },
    { phase: "uncertain registration", actor: "operator" },
    { phase: "accepted registration", actor: "guest" },
    { phase: "failed cancellation", actor: "operator" },
    { phase: "failed cancellation", actor: "system" },
  ] as const)("settles spawn rollback after $phase ($actor)", async ({ phase, actor }) => {
    const cancelFails = phase === "failed cancellation";
    const guest = actor === "guest";
    const source =
      actor === "system"
        ? undefined
        : cancelFails
          ? createSpawnOperatorSource()
          : createSpawnOperatorSource(
              guest ? ensureProfileForEmail("rollback-guest@example.test").id : "spawn-operator",
              [guest ? "operator.sessions.write" : "operator.write"],
            );
    const bound = await options.createBoundParent(
      source?.authority,
      cancelFails ? undefined : { guestProfileId: guest ? source?.authority.profileId : undefined },
    );
    const { context, runtime } = await options.createBoundGateway(bound);
    const readSession = sessionReader(bound.storePath);
    const preserveSession = cancelFails || phase === "uncertain registration";
    let childSessionKey: string | undefined;
    let childRunId: string | undefined;
    let childOwner: RpcSourceRef | undefined;
    const childExecution =
      phase === "preparation" ? undefined : abortableChild(options.runEmbeddedAgent);
    let invocation: Promise<unknown> | undefined;
    let registrationWrite: ReturnType<typeof interceptChildRegistrationWrite> | undefined;
    let retainedChildIdentity: { sessionId: string; lifecycleRevision?: string } | undefined;
    const cleanupAttemptSettled = createDeferred();
    let abortAttempts = 0;
    const registrationFailure = new SubagentRegistryWriteError(
      preserveSession ? "unknown" : "not-committed",
      new Error("fixture registry write failed"),
    );
    const dispatchSessionMethod = runtime.lifecycle.dispatchSessionMethod;
    const cleanupDispatch = preserveSession
      ? vi.spyOn(runtime.lifecycle, "dispatchSessionMethod").mockImplementation(async (...args) => {
          if (cancelFails) {
            if (args[0] !== "chat.abort") {
              return await dispatchSessionMethod(...args);
            }
            abortAttempts += 1;
            throw new Error("accepted-child abort failed");
          }
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
          source?.revoke();
          return { status: "failed" };
        },
      });
    } else {
      registrationWrite = interceptChildRegistrationWrite(
        bound.parentSessionKey,
        async (record) => {
          childSessionKey = record.child_session_key;
          childRunId = record.run_id;
          childOwner = expectDefined(
            rpcSourceTesting.get(record.run_id),
            "accepted child execution owner",
          );
          if (!cancelFails) {
            expect(subagentRuns.has(record.run_id)).toBe(false);
            expect(getRpcSourceIdentity(childOwner).sessionKey).toBe(record.child_session_key);
          }
          const captureIdentity = () => {
            const { sessionId, lifecycleRevision } = expectDefined(
              readSession(record.child_session_key),
              "uncertain registration child session",
            );
            retainedChildIdentity = { sessionId, lifecycleRevision };
          };
          if (cancelFails) {
            captureIdentity();
          }
          if (preserveSession) {
            await childExecution?.started.promise;
          }
          if (phase === "uncertain registration") {
            expect(
              expectDefined(childExecution?.state.signal, "running child abort signal").aborted,
            ).toBe(false);
            expect(rpcSourceTesting.get(record.run_id)).toBe(childOwner);
            captureIdentity();
            expect(getRpcSourceIdentity(childOwner)).toMatchObject({
              sessionKey: record.child_session_key,
              sessionId: retainedChildIdentity?.sessionId,
            });
          }
          if (phase === "accepted registration") {
            source?.revoke();
          }
          throw registrationFailure;
        },
      );
    }
    await collectFailure(failures, async () => {
      const invoke = createBoundSpawnInvocation(bound, {
        context: phase === "preparation" ? "fork" : "isolated",
      });
      const pending = cancelFails ? invoke("uncertain-registration") : invoke();
      invocation = pending;
      const completion =
        phase === "uncertain registration"
          ? (async () => {
              await Promise.race([cleanupAttemptSettled.promise, pending]);
              const childKey = expectDefined(childSessionKey, "registered child session");
              const runId = expectDefined(childRunId, "registered child run");
              const dispatch = expectDefined(cleanupDispatch, "bound cleanup dispatch observer");
              expectDefined(source, "operator source").authority.assertCurrent();
              expect(
                expectDefined(childExecution?.state.signal, "accepted child abort signal").aborted,
              ).toBe(true);
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
        message: `${phase}: rollback cleanup did not settle`,
      });
      const childKey = expectDefined(childSessionKey, "created child session");
      expect(result.details).toMatchObject({ status: "error", childSessionKey: childKey });
      if (preserveSession) {
        const dispatch = expectDefined(cleanupDispatch, "bound cleanup dispatch observer");
        expect(dispatch.mock.calls.some(([method]) => method === "sessions.delete")).toBe(false);
        expect(readSession(childKey)).toMatchObject(
          expectDefined(retainedChildIdentity, "original retained child identity"),
        );
        expect(options.runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(childExecution?.state.signal).toBeDefined();
        expect(registrationWrite?.failure).toHaveBeenCalledOnce();
      } else {
        expect(readSession(childKey)).toBeUndefined();
      }
      expect(readSession(bound.parentSessionKey)).toMatchObject({ sessionId: "parent-session" });
      if (phase === "preparation") {
        expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
      } else if (!cancelFails) {
        const runId = expectDefined(childRunId, "accepted child run");
        expect(rpcSourceTesting.has(runId)).toBe(false);
        expect(context.dedupe.get(`agent:${runId}`)).toMatchObject({
          payload: { runId, status: expect.stringMatching(/^(error|timeout)$/) },
        });
        expect(subagentRuns.has(runId)).toBe(false);
        if (childExecution?.state.signal) {
          expect(childExecution.state).toMatchObject({ signal: { aborted: true }, settled: true });
        } else {
          expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
        }
      }
      if (cancelFails) {
        const runId = expectDefined(childRunId, "accepted child before registration failure");
        const execution = expectDefined(childExecution, "running accepted child");
        const details = expectDefined(asOptionalRecord(result.details), "spawn failure details");
        expect(details).toMatchObject({ runId });
        expect(details.error).toContain(registrationFailure.message);
        expect(details.error).toContain("termination is not confirmed");
        expect(details.error).toContain("Its session is retained");
        expect(abortAttempts).toBe(1);
        expect(execution.state).toMatchObject({ signal: { aborted: false }, settled: false });
        expect(rpcSourceTesting.get(runId)).toBe(childOwner);
        expect(subagentRuns.has(runId)).toBe(false);
        bound.execution.beginClose();
        runtime.close();
        await prepareGatewayRunShutdown({
          resolveGatewayContext: bound.resolveGatewayContext,
          warnings: [],
        });
        await AsyncWorkScope.runWhenAllIdle(
          () => [bound.execution],
          () => {},
        );
        expect(execution.state).toMatchObject({ signal: { aborted: true }, settled: true });
        expect(rpcSourceTesting.has(runId)).toBe(false);
        expect(abortAttempts).toBe(1);
      }
    });
    childExecution?.started.resolve();
    if (!cancelFails) {
      spawnTesting.setDepsForTest();
      registrationWrite?.restore();
    }
    const cleanupMessage = "spawn rollback fixture cleanup";
    if (cancelFails && childOwner) {
      requestRpcSourceCancellation(childOwner, new Error(cleanupMessage));
    }
    cancelFixtureChildren(bound, cleanupMessage);
    if (cancelFails) {
      registrationWrite?.restore();
    }
    if (preserveSession) {
      await invocation?.catch((error: unknown) => {
        if (cancelFails) {
          failures.push(error);
        }
      });
    }
    failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
    if (preserveSession) {
      await collectFailure(failures, settleSubagentRegistryPersistenceWork);
    }
    cleanupDispatch?.mockRestore();
    await collectFailure(failures, async () => {
      await resetSubagentRegistryForTests({ persist: false });
      expect(source?.holds ?? 0).toBe(0);
    });
    options.throwBoundFailures(failures);
  });
}

import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { withTimeout } from "../../../infra/fs-safe.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../../tasks/detached-task-runtime.test-support.js";
import type { AdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "../registry/subagent-registry-persistence.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "../registry/subagent-registry-state.js";
import { settleSubagentRegistryPersistenceWork } from "../registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRunsByRunIdsFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import {
  createBoundSpawnInvocation,
  createSpawnOperatorSource,
  type createSpawnBoundaryParent,
} from "./subagent-spawn.production-boundary.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
type GatewayRuntime = ReturnType<typeof createGatewayInstanceRuntime>;

export function registerOperatorSpawnRollbackCases(options: {
  createBoundParent: (authority?: AdmittedRunOperatorAuthority) => Promise<BoundParent>;
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
    { phase: "preparation", label: "revoked-source preparation" },
    { phase: "accepted registration", label: "revoked-source accepted registration" },
    { phase: "required task rollback", label: "required task rollback" },
    { phase: "uncertain registration", label: "uncertain registration" },
  ] as const)(
    "rolls back an ordinary operator spawn and joins cleanup after $label failure",
    async ({ phase }) => {
      const source = createSpawnOperatorSource();
      const bound = await options.createBoundParent(source.authority);
      const { context, runtime } = await options.createBoundGateway(bound);
      const preserveSession =
        phase === "required task rollback" || phase === "uncertain registration";
      let childSessionKey: string | undefined;
      let childRunId: string | undefined;
      let embeddedSignal: AbortSignal | undefined;
      let embeddedSettled = false;
      const embeddedStarted = createDeferred();
      let invocation: Promise<unknown> | undefined;
      let rollbackRefused = false;
      let registrationUncertain = false;
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
        if (phase === "required task rollback") {
          const createTaskRun = vi.fn(() => null);
          setDetachedTaskLifecycleRuntime({
            ...getDetachedTaskLifecycleRuntime(),
            createQueuedTaskRun: createTaskRun,
            createRunningTaskRun: createTaskRun,
          });
          const actual = await vi.importActual<
            typeof import("../registry/subagent-registry-state.js")
          >("../registry/subagent-registry-state.js");
          const persist = vi.mocked(persistSubagentRunsToDiskAsyncOrThrow);
          persist
            .mockImplementationOnce(actual.persistSubagentRunsToDiskAsyncOrThrow)
            .mockImplementationOnce(async (runs, runIds) => {
              const record = expectDefined(
                [...subagentRuns.values()].find(
                  (entry) => entry.requesterSessionKey === bound.parentSessionKey,
                ),
                "durably registered child",
              );
              childSessionKey = record.childSessionKey;
              childRunId = record.runId;
              expect(createTaskRun).toHaveBeenCalledOnce();
              expect(runIds).toContain(record.runId);
              expect(runs.has(record.runId)).toBe(false);
              await embeddedStarted.promise;
              expect(expectDefined(embeddedSignal, "running child abort signal").aborted).toBe(
                false,
              );
              const acceptedRun = expectDefined(
                context.chatAbortControllers.get(record.runId),
                "accepted child execution owner",
              );
              const childEntry = expectDefined(
                loadSessionEntry({
                  storePath: bound.storePath,
                  sessionKey: record.childSessionKey,
                }),
                "retained child session",
              );
              retainedChildIdentity = {
                sessionId: childEntry.sessionId,
                lifecycleRevision: childEntry.lifecycleRevision,
              };
              expect(acceptedRun).toMatchObject({
                sessionKey: record.childSessionKey,
                sessionId: childEntry.sessionId,
              });
              const retained = {
                runId: record.runId,
                childSessionKey: record.childSessionKey,
                requesterSessionKey: bound.parentSessionKey,
              };
              // Terminal cleanup may retire this row after abort; prove recovery custody at refusal.
              expect(subagentRuns.get(record.runId)).toBe(record);
              expect(loadSubagentRunsByRunIdsFromSqlite([record.runId])).toMatchObject([retained]);
              rollbackRefused = true;
              throw new SubagentRegistryWriteError(
                "not-committed",
                new Error("required task registry rollback failed"),
              );
            });
        } else {
          vi.mocked(persistSubagentRunsToDiskAsyncOrThrow).mockImplementationOnce(async (runs) => {
            const record = expectDefined(
              [...runs.values()].find(
                (entry) => entry.requesterSessionKey === bound.parentSessionKey,
              ),
              "ordinary child registration",
            );
            childSessionKey = record.childSessionKey;
            childRunId = record.runId;
            expect(subagentRuns.has(record.runId)).toBe(false);
            const acceptedRun = expectDefined(
              context.chatAbortControllers.get(record.runId),
              "accepted child execution owner",
            );
            expect(acceptedRun.sessionKey).toBe(record.childSessionKey);
            if (phase === "uncertain registration") {
              await embeddedStarted.promise;
              expect(expectDefined(embeddedSignal, "running child abort signal").aborted).toBe(
                false,
              );
              expect(context.chatAbortControllers.get(record.runId)).toBe(acceptedRun);
              const childEntry = expectDefined(
                loadSessionEntry({
                  storePath: bound.storePath,
                  sessionKey: record.childSessionKey,
                }),
                "uncertain registration child session",
              );
              retainedChildIdentity = {
                sessionId: childEntry.sessionId,
                lifecycleRevision: childEntry.lifecycleRevision,
              };
              expect(acceptedRun).toMatchObject({
                sessionKey: record.childSessionKey,
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
          });
        }
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
          expect(rollbackRefused).toBe(phase === "required task rollback");
          expect(registrationUncertain).toBe(phase === "uncertain registration");
          const dispatch = expectDefined(cleanupDispatch, "bound cleanup dispatch observer");
          expect(dispatch.mock.calls.some(([method]) => method === "sessions.delete")).toBe(false);
          expect(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: childKey }),
          ).toMatchObject(expectDefined(retainedChildIdentity, "original retained child identity"));
          expect(options.runEmbeddedAgent).toHaveBeenCalledOnce();
          expect(embeddedSignal).toBeDefined();
          if (phase === "uncertain registration") {
            expect(persistSubagentRunsToDiskAsyncOrThrow).toHaveBeenCalledOnce();
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
          if (phase !== "required task rollback") {
            expect(subagentRuns.has(runId)).toBe(false);
          }
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
        vi.mocked(persistSubagentRunsToDiskAsyncOrThrow).mockReset();
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
          } finally {
            resetDetachedTaskLifecycleRuntimeForTests();
          }
        }
        cleanupDispatch?.mockRestore();
        try {
          resetSubagentRegistryForTests({ persist: false });
          expect(source.holds).toBe(0);
        } catch (error) {
          failures.push(error);
        }
        options.throwBoundFailures(failures);
      }
    },
  );
}

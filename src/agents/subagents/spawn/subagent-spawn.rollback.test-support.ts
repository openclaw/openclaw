import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi, type Mock } from "vitest";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { withTimeout } from "../../../infra/fs-safe.js";
import type { SqliteWorkerCommand } from "../../../infra/sqlite-worker-contract.js";
import type { OpenClawStateWorkerOperations } from "../../../state/openclaw-state-worker-contract.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import type { AdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
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
  it.each(["preparation", "accepted registration"] as const)(
    "rolls back an ordinary operator spawn after revoked-source %s failure",
    async (phase) => {
      const source = createSpawnOperatorSource();
      const bound = await options.createBoundParent(source.authority);
      const { context, runtime } = await options.createBoundGateway(bound);
      let childSessionKey: string | undefined;
      let childRunId: string | undefined;
      let embeddedSignal: AbortSignal | undefined;
      let embeddedSettled = false;
      const failures: unknown[] = [];
      let restoreWriteFailure: (() => void) | undefined;
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
        const runWorkerOperation = stateWorker.runOpenClawStateWorkerOperation;
        const writeFailure = vi
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
                        const record =
                          command.type === "subagents.persistChanges"
                            ? command.input.values.find(
                                (row) => row.requester_session_key === bound.parentSessionKey,
                              )
                            : undefined;
                        if (!record) {
                          return scope.execute(command);
                        }
                        childSessionKey = record.child_session_key;
                        childRunId = record.run_id;
                        const acceptedRun = expectDefined(
                          context.chatAbortControllers.get(record.run_id),
                          "accepted child execution owner",
                        );
                        expect(acceptedRun.sessionKey).toBe(record.child_session_key);
                        source.revoke();
                        throw new Error("ordinary child registry write failed");
                      },
                    ),
                }),
              workerOptions,
            ),
          );
        restoreWriteFailure = () => writeFailure.mockRestore();
      }
      try {
        const result = await withTimeout(
          createBoundSpawnInvocation(bound, {
            context: phase === "preparation" ? "fork" : "isolated",
          })(),
          60_000,
          { message: "ordinary source-revoked spawn cleanup did not settle" },
        );
        const childKey = expectDefined(childSessionKey, "created child session");
        expect(result.details).toMatchObject({ status: "error", childSessionKey: childKey });
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: childKey }),
        ).toBeUndefined();
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
        spawnTesting.setDepsForTest();
        restoreWriteFailure?.();
        for (const entry of context.chatAbortControllers.values()) {
          if (entry !== bound.parent.entry) {
            entry.controller.abort(new Error("spawn rollback fixture cleanup"));
          }
        }
        failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
        try {
          expect(source.holds).toBe(0);
        } catch (error) {
          failures.push(error);
        }
        options.throwBoundFailures(failures);
      }
    },
  );
}

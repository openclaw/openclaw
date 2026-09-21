import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { expect, it, type Mock } from "vitest";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { withTimeout } from "../../../infra/fs-safe.js";
import type { AdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { testing as registryTesting } from "../registry/subagent-registry.test-helpers.js";
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
        registryTesting.setDepsForTest({
          persistSubagentRunsToDiskOrThrow: () => {
            const record = expectDefined(
              [...subagentRuns.values()].find(
                (entry) => entry.requesterSessionKey === bound.parentSessionKey,
              ),
              "ordinary child registration",
            );
            childSessionKey = record.childSessionKey;
            childRunId = record.runId;
            const acceptedRun = expectDefined(
              context.chatAbortControllers.get(record.runId),
              "accepted child execution owner",
            );
            expect(acceptedRun.sessionKey).toBe(record.childSessionKey);
            source.revoke();
            throw new Error("ordinary child registry write failed");
          },
        });
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
        registryTesting.setDepsForTest();
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

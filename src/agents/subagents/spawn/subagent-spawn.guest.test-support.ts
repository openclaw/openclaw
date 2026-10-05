import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { normalizeAcceptedSessionSpawnResult } from "../../accepted-session-spawn.js";
import {
  readAdmittedRunOperatorAuthority,
  resolvePreparedRunAdmission,
} from "../../admitted-run-context.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { settleRequesterAfterSessionSpawns } from "../registry/subagent-registry.js";
import {
  createBoundSpawnInvocation,
  type createSpawnBoundaryParent,
  type createSpawnOperatorSource,
} from "./subagent-spawn.production-boundary.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
type Source = ReturnType<typeof createSpawnOperatorSource>;
type GatewayRuntime = ReturnType<typeof createGatewayInstanceRuntime>;

export function registerGuestSpawnCases(options: {
  createGuestParent: (audit?: boolean) => Promise<{
    bound: BoundParent;
    source: Source;
    modelPolicy: Source["authority"]["modelPolicy"];
    scopes: string[];
  }>;
  createBoundGateway: (
    bound: BoundParent,
  ) => Promise<{ context: GatewayRequestContext; runtime: GatewayRuntime }>;
  closeBoundGateway: (
    bound: BoundParent,
    runtime: GatewayRuntime,
    childRunId?: string,
  ) => Promise<unknown[]>;
  waitForEmbeddedRun: (
    bound: BoundParent,
    runId: string,
    started?: Promise<void>,
    calls?: number,
  ) => Promise<void>;
  throwBoundFailures: (failures: unknown[]) => void;
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>;
}) {
  it.for([false, true])(
    "launches an owned hidden child and returns its result (audit=%s)",
    async (audit, { signal }) => {
      const { bound, source, modelPolicy, scopes } = await options.createGuestParent(audit);
      const { runtime } = await options.createBoundGateway(bound);
      const nativeAnnounce = await vi.importActual<
        typeof import("../announce/subagent-announce.js")
      >("../announce/subagent-announce.js");
      const delivered = createDeferred<Awaited<ReturnType<typeof runSubagentAnnounceFlow>>>();
      vi.mocked(runSubagentAnnounceFlow).mockImplementation(async (params) => {
        try {
          const result = await nativeAnnounce.runSubagentAnnounceFlow(params);
          delivered.resolve(result);
          return result;
        } catch (error) {
          delivered.reject(error);
          throw error;
        }
      });
      const started = createDeferred();
      const modelResult = createDeferred<EmbeddedAgentRunResult>();
      const parentPrompts: string[] = [];
      options.runEmbeddedAgent.mockImplementation(async (params) => {
        const admitted = await resolvePreparedRunAdmission({
          runId: params.runId,
          runtimeKind: "embedded",
          admittedRunContext: params.admittedRunContext,
          preparedRunAdmission: params.preparedRunAdmission,
        });
        const authority = readAdmittedRunOperatorAuthority(admitted);
        expect(authority?.profileId).toBe(source.authority.profileId);
        expect(authority?.scopes).toEqual(scopes);
        expect(authority?.modelPolicy).toBe(modelPolicy);
        expect(authority?.modelPolicy?.allows({ provider: "custom", model: "forbidden" })).toBe(
          false,
        );
        await params.onExecutionStarted?.();
        if (params.sessionKey === bound.parentSessionKey) {
          parentPrompts.push(params.prompt);
          return { payloads: [{ text: "Parent received the result" }], meta: { durationMs: 1 } };
        }
        started.resolve();
        return await modelResult.promise;
      });
      let childRunId: string | undefined;
      const failures: unknown[] = [];
      try {
        const result = await createBoundSpawnInvocation(bound, {
          visible: false,
          context: "isolated",
          completionTarget: "parent",
        })();
        expect(result.details, JSON.stringify(result)).toMatchObject({ status: "accepted" });
        const details = result.details as { childSessionKey: string; runId: string };
        childRunId = details.runId;
        await options.waitForEmbeddedRun(bound, details.runId, started.promise);
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: details.childSessionKey }),
        ).toMatchObject({
          spawnedBy: bound.parentSessionKey,
          createdActor: { type: "human", source: "profile", id: source.authority.profileId },
          sandbox: "required",
        });
        expect(
          await settleRequesterAfterSessionSpawns({
            requesterSessionKey: bound.parentSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId: bound.parentRunId,
            requesterYielded: false,
            acceptedSessionSpawns: [
              expectDefined(normalizeAcceptedSessionSpawnResult(result), "accepted child"),
            ],
          }),
        ).toBe(true);
        await bound.admission.close();
        bound.parent.cleanup();
        source.closeRequest();
        modelResult.resolve({
          payloads: [{ text: "guest child complete" }],
          meta: { durationMs: 1, finalAssistantVisibleText: "guest child complete" },
        });
        expect(await withinTest(delivered.promise, signal)).toBe("delivered");
        expect(parentPrompts).toHaveLength(1);
        expect(parentPrompts[0]).toContain("guest child complete");
      } catch (error) {
        failures.push(error);
      } finally {
        modelResult.resolve({
          payloads: [{ text: "guest child complete" }],
          meta: { durationMs: 1 },
        });
        failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
        options.throwBoundFailures(failures);
      }
    },
  );

  it.each(["foreign target", "serialized request", "replaced child", "revoked source"] as const)(
    "rejects a guest hidden launch after %s without affecting another session",
    async (change) => {
      const { bound, source } = await options.createGuestParent(false);
      const { runtime } = await options.createBoundGateway(bound);
      const foreignKey = "agent:main:foreign-session";
      await upsertSessionEntryCore(
        { storePath: bound.storePath, sessionKey: foreignKey },
        {
          sessionId: "foreign-session",
          createdActor: { type: "human", source: "profile", id: "other-person" },
          sandbox: "required",
        },
      );
      let childKey: string | undefined;
      const failures: unknown[] = [];
      spawnTesting.setDepsForTest({
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
          dispatchOptions?: Parameters<typeof dispatchGatewayMethodInProcess>[2],
        ) => {
          if (method === "agent") {
            childKey = String(params.sessionKey);
            if (change === "foreign target") {
              params.sessionKey = foreignKey;
            }

            if (change === "revoked source") {
              source.revoke();
            }
            if (change === "replaced child") {
              await upsertSessionEntryCore(
                { storePath: bound.storePath, sessionKey: childKey },
                {
                  lifecycleRevision: "successor-lifecycle",
                },
              );
            }
          }
          return await dispatchGatewayMethodInProcess<T>(
            method,
            change === "serialized request" ? { ...params } : params,
            dispatchOptions,
          );
        },
      });
      try {
        const result = await createBoundSpawnInvocation(bound, {
          visible: false,
          context: "isolated",
          completionTarget: "parent",
        })();
        expect(result.details).toMatchObject({ status: "error" });
        expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
        const child = loadSessionEntry({
          storePath: bound.storePath,
          sessionKey: expectDefined(childKey, "created child"),
        });
        if (change === "replaced child") {
          expect(child).toMatchObject({ lifecycleRevision: "successor-lifecycle" });
        } else {
          expect(child).toBeUndefined();
        }
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: foreignKey }),
        ).toMatchObject({ sessionId: "foreign-session", createdActor: { id: "other-person" } });
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: bound.parentSessionKey }),
        ).toMatchObject({ sessionId: "parent-session" });
      } catch (error) {
        failures.push(error);
      } finally {
        spawnTesting.setDepsForTest();
        failures.push(...(await options.closeBoundGateway(bound, runtime)));
        options.throwBoundFailures(failures);
      }
    },
  );
}

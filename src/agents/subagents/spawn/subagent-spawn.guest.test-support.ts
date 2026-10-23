import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { normalizeAcceptedSessionSpawnResult as acceptedSpawn } from "../../accepted-session-spawn.js";
import {
  readAdmittedRunOperatorAuthority,
  resolvePreparedRunAdmission,
} from "../../admitted-run-context.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { buildAgentInternalEventContext, type AgentInternalEvent } from "../../internal-events.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../../internal-runtime-context.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { settleRequesterAfterSessionSpawns } from "../registry/subagent-registry.js";
import {
  collectFailure,
  sessionReader,
  visibleResult,
  type BoundaryHarness,
  type WaitForEmbeddedRun,
} from "./subagent-spawn.fixtures.test-support.js";
import {
  createBoundSpawnInvocation,
  recordSpawnBoundaryFinal,
  type createSpawnOperatorSource,
  type RequestCustodySpawnCaseOptions,
} from "./subagent-spawn.production-boundary.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

type Source = ReturnType<typeof createSpawnOperatorSource>;
type BoundParent = Awaited<ReturnType<RequestCustodySpawnCaseOptions["createBoundParent"]>>;
const hiddenSpawn = { visible: false, context: "isolated", completionTarget: "parent" } as const;

export function registerGuestSpawnCases(
  options: BoundaryHarness & {
    createGuestParent: (audit?: boolean) => Promise<{
      bound: BoundParent;
      source: Source;
      modelPolicy: Source["authority"]["modelPolicy"];
      scopes: string[];
    }>;
    waitForEmbeddedRun: WaitForEmbeddedRun;
  },
) {
  it.for([false, true])(
    "launches an owned hidden child and returns its result (audit=%s)",
    async (audit, { signal }) => {
      const { bound, source, modelPolicy, scopes } = await options.createGuestParent(audit);
      const readSession = sessionReader(bound.storePath);
      const { runtime } = await options.createBoundGateway(bound);
      const nativeAnnounce = await vi.importActual<
        typeof import("../announce/subagent-announce.js")
      >("../announce/subagent-announce.js");
      const delivered = createDeferred<Awaited<ReturnType<typeof runSubagentAnnounceFlow>>>();
      vi.mocked(runSubagentAnnounceFlow).mockImplementation((params) => {
        const result = nativeAnnounce.runSubagentAnnounceFlow(params);
        void result.then(delivered.resolve, delivered.reject);
        return result;
      });
      const started = createDeferred();
      const modelResult = createDeferred<EmbeddedAgentRunResult>();
      const parentTurns: { prompt: string; internalEvents?: AgentInternalEvent[] }[] = [];
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
        const parentTurn = params.sessionKey === bound.parentSessionKey;
        if (parentTurn) {
          parentTurns.push({ prompt: params.prompt, internalEvents: params.internalEvents });
        } else {
          started.resolve();
        }
        const text = parentTurn ? "Parent received the result" : "guest child complete";
        const result = parentTurn ? visibleResult(text) : await modelResult.promise;
        await recordSpawnBoundaryFinal({
          storePath: bound.storePath,
          sessionKey: expectDefined(params.sessionKey, "child session"),
          runId: params.runId,
          text,
        });
        return result;
      });
      let childRunId: string | undefined;
      const failures: unknown[] = [];
      await collectFailure(failures, async () => {
        const result = await createBoundSpawnInvocation(bound, hiddenSpawn)();
        const details = expectDefined(
          acceptedSpawn(result),
          `accepted child: ${JSON.stringify(result.details)}`,
        );
        childRunId = details.runId;
        await options.waitForEmbeddedRun(bound, details.runId, started.promise);
        expect(readSession(details.childSessionKey)).toMatchObject({
          spawnedBy: bound.parentSessionKey,
          createdActor: {
            type: "human",
            source: "profile",
            id: source.authority.profileId,
            delegatedBy: { type: "human", source: "profile", id: source.authority.profileId },
          },
          sandbox: "required",
        });
        expect(
          await settleRequesterAfterSessionSpawns({
            requesterSessionKey: bound.parentSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId: bound.parentRunId,
            requesterYielded: false,
            acceptedSessionSpawns: [details],
          }),
        ).toBe(true);
        bound.admission.close();
        bound.parent.cleanup();
        source.closeRequest();
        modelResult.resolve(visibleResult("guest child complete"));
        expect(await withinTest(delivered.promise, signal)).toBe("delivered");
        expect(parentTurns).toHaveLength(1);
        expect(parentTurns[0]?.prompt).toContain(RUNTIME_EVENT_USER_PROMPT);
        expect(buildAgentInternalEventContext(parentTurns[0]?.internalEvents)).toContainEqual({
          kind: "conversation-data",
          text: expect.stringContaining("guest child complete"),
        });
      });
      modelResult.resolve(visibleResult("guest child complete"));
      failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
      options.throwBoundFailures(failures);
    },
  );

  it.each(["foreign target", "serialized request", "replaced child", "revoked source"] as const)(
    "rejects a guest hidden launch after %s without affecting another session",
    async (change) => {
      const { bound, source } = await options.createGuestParent(false);
      const readSession = sessionReader(bound.storePath);
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
                { lifecycleRevision: "successor-lifecycle" },
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
      await collectFailure(failures, async () => {
        const result = await createBoundSpawnInvocation(bound, hiddenSpawn)();
        expect(result.details).toMatchObject({ status: "error" });
        expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
        const child = readSession(expectDefined(childKey, "created child"));
        if (change === "replaced child") {
          expect(child).toMatchObject({ lifecycleRevision: "successor-lifecycle" });
        } else {
          expect(child).toBeUndefined();
        }
        expect(readSession(foreignKey)).toMatchObject({
          sessionId: "foreign-session",
          createdActor: { id: "other-person" },
        });
        expect(readSession(bound.parentSessionKey)).toMatchObject({ sessionId: "parent-session" });
      });
      spawnTesting.setDepsForTest();
      failures.push(...(await options.closeBoundGateway(bound, runtime)));
      options.throwBoundFailures(failures);
    },
  );
}

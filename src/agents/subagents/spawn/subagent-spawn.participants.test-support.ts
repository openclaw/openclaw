import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { withPersonalToolTurn } from "../../../auto-reply/reply/personal-tool-turn.test-support.js";
import {
  assignSessionOwner,
  listSessionEntryKeysReadOnly,
  loadSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { getSessionWorkAdmissionRelease } from "../../../sessions/session-lifecycle-admission.js";
import {
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  resolvePreparedRunAdmission,
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
} from "../../admitted-run-context.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { observeRootWork } from "../registry/subagent-registry.browser-cleanup.test-support.js";
import { closeSwarmScheduler, enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  createBoundSpawnInvocation,
  createSpawnOperatorSource,
  type createSpawnBoundaryParent,
} from "./subagent-spawn.production-boundary.test-support.js";

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
type ChildExecution = { admitted: AdmittedRunContext; signal: AbortSignal };

export function registerParticipantSpawnCases(options: {
  createBoundParent: (authority?: AdmittedRunOperatorAuthority) => Promise<BoundParent>;
  createBoundGateway: (bound: BoundParent) => Promise<{
    context: GatewayRequestContext;
    runtime: ReturnType<typeof createGatewayInstanceRuntime>;
  }>;
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>;
  parentSessionKey: string;
  parentRunId: string;
}) {
  const { createBoundParent, createBoundGateway, runEmbeddedAgent, parentSessionKey, parentRunId } =
    options;
  it.each([false, true])(
    "spawns for the named participant and transfers custody (visible=%s)",
    async (visible) => {
      const settleRootWork = observeRootWork();
      const aliceSource = createSpawnOperatorSource("alice");
      const bobSource = createSpawnOperatorSource("bob");
      const alice = {
        profileId: "alice",
        senderId: "alice",
        name: "Alice",
        operatorAuthority: aliceSource.authority,
      };
      const bob = {
        profileId: "bob",
        senderId: "bob",
        name: "Bob",
        operatorAuthority: bobSource.authority,
      };
      const bound = await createBoundParent(aliceSource.authority);
      assignSessionOwner(
        { agentId: "main", storePath: bound.storePath, sessionKey: parentSessionKey },
        {
          owner: { type: "human", id: "alice" },
          assignedBy: { type: "system", id: "fixture" },
        },
      );
      const { context, runtime } = await createBoundGateway(bound);
      const modelRuns = createDeferred<EmbeddedAgentRunResult>();
      const childSettlements: Promise<void>[] = [];
      let entered = createDeferred<ChildExecution>();
      runEmbeddedAgent.mockImplementation(async (params) => {
        try {
          const admitted = await resolvePreparedRunAdmission({
            runId: params.runId,
            runtimeKind: "embedded",
            admittedRunContext: params.admittedRunContext,
            preparedRunAdmission: params.preparedRunAdmission,
          });
          entered.resolve({
            admitted,
            signal: expectDefined(params.abortSignal, "child execution signal"),
          });
          return await modelRuns.promise;
        } catch (error) {
          entered.reject(error);
          throw error;
        }
      });
      const tool = createSessionsSpawnTool({
        config: bound.cfg,
        agentSessionKey: parentSessionKey,
        requesterRunId: parentRunId,
        requesterTurnRunId: parentRunId,
      });
      const invoke = (user?: string) =>
        tool.execute!("participant-spawn", {
          task: "Bounded participant child",
          visible,
          context: "isolated",
          user,
        });
      const keys = () => listSessionEntryKeysReadOnly({ storePath: bound.storePath });
      try {
        await withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
          withPersonalToolTurn(
            {
              owner: alice,
              sessionKey: parentSessionKey,
              sessionId: "parent-session",
              runId: parentRunId,
              admittedRunContext: bound.admitted,
              gatewayContextResolver: () => context,
            },
            async (turn) => {
              const spawn = async (user: string | undefined, profileId: string) => {
                entered = createDeferred<ChildExecution>();
                const result = await invoke(user);
                expect(result.details, JSON.stringify(result)).toMatchObject({
                  status: "accepted",
                });
                const details = result.details as {
                  childSessionKey: string;
                  runId: string;
                  owner?: { type: string; id: string };
                };
                const entry = expectDefined(
                  loadSessionEntry({
                    storePath: bound.storePath,
                    sessionKey: details.childSessionKey,
                  }),
                  "created child session",
                );
                const settled = visible
                  ? expectDefined(
                      getSessionWorkAdmissionRelease({
                        scope: bound.storePath,
                        identities: [details.childSessionKey, entry.sessionId],
                      }),
                      "visible child execution custody",
                    )
                  : undefined;
                if (settled) {
                  childSettlements.push(settled);
                }
                const { admitted, signal } = await Promise.race([
                  entered.promise,
                  ...(settled
                    ? [
                        settled.then(() => {
                          throw new Error(
                            `Spawn execution finished before model entry: ${JSON.stringify({ warnings: vi.mocked(context.logGateway.warn).mock.calls, receipt: context.dedupe.get(`chat:${details.runId}`) })}`,
                          );
                        }),
                      ]
                    : []),
                ]);
                const authority = readAdmittedRunOperatorAuthority(admitted);
                expect(authority?.profileId).toBe(profileId);
                if (visible) {
                  const owner =
                    profileId === "alice"
                      ? { type: "human", id: "alice" }
                      : { type: "agent", id: "main" };
                  expect(entry?.owner?.actor).toMatchObject(owner);
                  expect(details.owner).toMatchObject(owner);
                }
                return {
                  admitted,
                  signal,
                  authority: expectDefined(authority, "child operator"),
                  ...details,
                };
              };
              const steered = await turn.steer(bob);
              expect(steered, JSON.stringify(steered)).toMatchObject({ status: "accepted" });
              const existingKeys = await keys();
              await expect(invoke()).rejects.toThrow(/Alice.*Bob|Bob.*Alice/);
              expect(await keys()).toEqual(existingKeys);
              await spawn("alice", "alice");
              const bobChild = await spawn("bob", "bob");
              turn.complete();
              bound.admission.close();
              bound.parent.cleanup();
              aliceSource.closeRequest();
              bobSource.closeRequest();
              expect(bobSource.holds).toBeGreaterThan(0);
              expect(() => bobChild.authority.assertCurrent()).not.toThrow();
              expect(getAdmittedRunDelegatedAuthority(bobChild.admitted)).toBeDefined();
              bobSource.revoke();
              expect(() => bobChild.authority.assertCurrent()).toThrow("operator source revoked");
              expect(bobChild.signal.aborted).toBe(true);
            },
          ),
        );
      } finally {
        modelRuns.resolve({ payloads: [{ text: "child complete" }], meta: { durationMs: 1 } });
        await Promise.all(childSettlements);
        await bound.execution.drain();
        await settleRootWork();
        runtime.close();
        bound.admission.close();
        bound.parent.cleanup();
      }
    },
  );

  it("keeps a queued child's named participant authority after the turn closes", async () => {
    const settleRootWork = observeRootWork();
    const aliceSource = createSpawnOperatorSource("alice");
    const bobSource = createSpawnOperatorSource("bob");
    const bound = await createBoundParent(aliceSource.authority);
    const { context, runtime } = await createBoundGateway(bound);
    const groupId = "participant-queued";
    const capacity = createDeferred();
    enqueueSwarmRun({
      groupId: JSON.stringify(["main", parentSessionKey, groupId]),
      runId: "participant-capacity",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        capacity.resolve();
      },
      onStartFailure: () => true,
    });
    await capacity.promise;
    const modelRun = createDeferred<EmbeddedAgentRunResult>();
    const entered = createDeferred<AdmittedRunContext>();
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      const admitted = await resolvePreparedRunAdmission({
        runId: params.runId,
        runtimeKind: "embedded",
        admittedRunContext: params.admittedRunContext,
        preparedRunAdmission: params.preparedRunAdmission,
      });
      entered.resolve(admitted);
      return await modelRun.promise;
    });
    try {
      await withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
        withPersonalToolTurn(
          {
            owner: {
              profileId: "alice",
              senderId: "alice",
              name: "Alice",
              operatorAuthority: aliceSource.authority,
            },
            sessionKey: parentSessionKey,
            sessionId: "parent-session",
            runId: parentRunId,
            admittedRunContext: bound.admitted,
            gatewayContextResolver: () => context,
          },
          async (turn) => {
            const steered = await turn.steer({
              profileId: "bob",
              senderId: "bob",
              name: "Bob",
              operatorAuthority: bobSource.authority,
            });
            expect(steered, JSON.stringify(steered)).toMatchObject({ status: "accepted" });
            const result = await createBoundSpawnInvocation(bound, {
              collect: true,
              groupId,
              context: "isolated",
              user: "bob",
            })();
            expect(result.details, JSON.stringify(result)).toMatchObject({ status: "accepted" });
            expect(runEmbeddedAgent).not.toHaveBeenCalled();
            turn.complete();
            bound.admission.close();
            bound.parent.cleanup();
            aliceSource.closeRequest();
            bobSource.closeRequest();
            expect(bobSource.holds).toBeGreaterThan(0);
            expect(releaseSwarmRun("participant-capacity")).toBe(true);
            const admitted = await entered.promise;
            const childAuthority = expectDefined(
              readAdmittedRunOperatorAuthority(admitted),
              "queued child operator",
            );
            expect(childAuthority.profileId).toBe("bob");
            expect(() => childAuthority.assertCurrent()).not.toThrow();
            bobSource.revoke();
            expect(() => childAuthority.assertCurrent()).toThrow("operator source revoked");
          },
        ),
      );
    } finally {
      modelRun.resolve({ payloads: [{ text: "queued child complete" }], meta: { durationMs: 1 } });
      releaseSwarmRun("participant-capacity");
      await closeSwarmScheduler();
      await bound.execution.drain();
      await settleRootWork();
      runtime.close();
      bound.admission.close();
      bound.parent.cleanup();
    }
  });
}

import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionEnvelope,
} from "../../../audit/execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "../../../audit/execution-identity-spawn-admission.js";
import { withPersonalToolTurn } from "../../../auto-reply/reply/personal-tool-turn.test-support.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  assignSessionOwner,
  listSessionEntryKeysReadOnly,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { bindSessionRowProjection } from "../../../gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../../gateway/session-row-projection.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { getRpcSource } from "../../../sessions/session-controller.rpc-sources.js";
import {
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  resolvePreparedRunAdmission,
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
} from "../../admitted-run-context.js";
import { createOpenClawCodingToolsInternalAsync } from "../../agent-tools.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { advancePreparedModelRuntimeConfig } from "../../prepared-model-runtime.js";
import type { RequesterOrigin } from "../../requester-origin.js";
import { createSessionsSendTool } from "../../tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { observeRootWork } from "../registry/subagent-registry.browser-cleanup.test-support.js";
import { closeSwarmScheduler, enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  createBoundSpawnInvocation,
  createSpawnOperatorSource,
  type createSpawnBoundaryParent,
} from "./subagent-spawn.production-boundary.test-support.js";

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
type ChildExecution = {
  admitted: AdmittedRunContext;
  signal: AbortSignal;
  requesterOrigin?: RequesterOrigin;
};

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
    "spawns for the incumbent or selected participant and transfers custody (visible=%s)",
    async (visible) => {
      const envelopes: ExecutionIdentityAdmissionEnvelope[] = [];
      onTestFinished(
        configureExecutionIdentityAdmissionSink((work) => {
          if (work.kind === "capture") {
            envelopes.push(work.envelope);
          }
          return true;
        }),
      );
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
      const parentEnvelope = expectDefined(
        envelopes.find((envelope) => envelope.runId === parentRunId),
        "parent admission envelope",
      );
      const originalParentEnvelope = structuredClone(parentEnvelope);
      assignSessionOwner(
        { agentId: "main", storePath: bound.storePath, sessionKey: parentSessionKey },
        {
          owner: { type: "human", id: "alice" },
          assignedBy: { type: "system", id: "fixture" },
        },
      );
      bound.cfg.tools = { ...bound.cfg.tools, sessions: { visibility: "all" } };
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
          if (visible) {
            expect(params.userTurnTranscriptRecorder?.getPendingInputMessage?.()).toMatchObject({
              __openclaw: { senderId: "agent:main" },
              provenance: {
                kind: "inter_session",
                sourceSessionKey: parentSessionKey,
                sourceTool: "sessions_spawn",
              },
            });
          }
          entered.resolve({
            admitted,
            signal: expectDefined(params.abortSignal, "child execution signal"),
            requesterOrigin: params.requesterOrigin,
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
              allowCollaborativeSteering: true,
              sessionKey: parentSessionKey,
              sessionId: "parent-session",
              runId: parentRunId,
              admittedRunContext: bound.admitted,
              gatewayContextResolver: () => context,
              controllerInput: expectDefined(getRpcSource(parentRunId), "parent controller source")
                .input,
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
                      getRpcSource(details.runId)?.input.settlement.promise,
                      "visible child execution custody",
                    )
                  : undefined;
                if (settled) {
                  childSettlements.push(settled);
                }
                const { admitted, signal, requesterOrigin } = await Promise.race([
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
                expect(requesterOrigin).toMatchObject({
                  operatorProfileId: profileId,
                  senderId: profileId,
                  messageProvider: "webchat",
                  conversationId: parentSessionKey,
                });
                const envelope = expectDefined(
                  envelopes.find((candidate) => candidate.runId === details.runId),
                  "child admission envelope",
                );
                expect(envelope).toMatchObject({
                  contextId: admitted.executionIdentityToken?.contextId,
                  executionId: admitted.executionIdentityToken?.executionId,
                  runId: details.runId,
                  invoker: { state: "present", kind: "agent", rawPrincipalRef: "main" },
                  representedSubject: {
                    state: "present",
                    kind: "person",
                    rawPrincipalRef: profileId,
                  },
                });
                expect(envelope.contextId).not.toBe(parentEnvelope.contextId);
                expect(envelope.executionId).not.toBe(parentEnvelope.executionId);
                const [lineage] = executionIdentitySpawnAdmission({
                  operation: "parse",
                  value: executionIdentitySpawnAdmission({ operation: "read", value: envelope }),
                });
                expect(lineage).toMatchObject({
                  parentContextId: parentEnvelope.contextId,
                  parentExecutionId: parentEnvelope.executionId,
                  parentRunId,
                  parentAgentId: "main",
                });
                expect(parentEnvelope).toEqual(originalParentEnvelope);
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
              expect(steered, JSON.stringify(steered)).toMatchObject({
                status: "accepted",
              });
              if (!visible) {
                const sessionKey = "agent:main:dashboard:selected-send";
                await upsertSessionEntryCore(
                  { agentId: "main", storePath: bound.storePath, sessionKey },
                  { sessionId: "selected-send", updatedAt: 1, visibility: "shared" },
                );
                const projection = await createSessionRowProjection({
                  cfg: bound.cfg,
                  modelCatalog: [],
                });
                onTestFinished(async () => {
                  projection.dispose();
                  await projection.ensureMaterialized();
                });
                bindSessionRowProjection(context, () => projection);
                await projection.ensureMaterialized();
                entered = createDeferred<ChildExecution>();
                const sent = await createSessionsSendTool({
                  config: bound.cfg,
                  agentSessionKey: parentSessionKey,
                  completionOwner: "caller",
                }).execute("selected-send", {
                  sessionKey,
                  user: bob.profileId,
                  message: "Run this new execution for the selected participant",
                  mode: "followup",
                  timeoutSeconds: 0,
                });
                expect(sent.details, JSON.stringify(sent)).toMatchObject({
                  status: "accepted",
                  targetDisposition: "queued",
                });
                const child = await entered.promise;
                expect(readAdmittedRunOperatorAuthority(child.admitted)?.profileId).toBe("bob");
                expect(child.requesterOrigin).toMatchObject({
                  operatorProfileId: "bob",
                  senderId: "bob",
                  messageProvider: "webchat",
                  conversationId: parentSessionKey,
                });
                expect(
                  envelopes.find(
                    (envelope) =>
                      envelope.contextId === child.admitted.executionIdentityToken?.contextId,
                  ),
                ).toMatchObject({
                  invoker: { state: "present", kind: "agent", rawPrincipalRef: "main" },
                  representedSubject: { state: "present", kind: "person", rawPrincipalRef: "bob" },
                });
                expect(parentEnvelope).toEqual(originalParentEnvelope);
              }
              const existingKeys = await keys();
              await expect(invoke("unknown-profile")).rejects.toThrow(/not a participant/i);
              expect(await keys()).toEqual(existingKeys);
              const bobChild = await spawn("bob", "bob");
              const aliceChild = await spawn(undefined, "alice");
              await turn.complete();
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
              expect(() => aliceChild.authority.assertCurrent()).not.toThrow();
              expect(aliceChild.signal.aborted).toBe(false);
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

  it("admits a queued selected participant with current policy after the turn closes", async () => {
    const settleRootWork = observeRootWork();
    const aliceSource = createSpawnOperatorSource("alice");
    const bobSource = createSpawnOperatorSource("bob");
    const bound = await createBoundParent(aliceSource.authority);
    const { context, runtime } = await createBoundGateway(bound);
    let currentConfig = bound.cfg;
    context.getRuntimeConfig = () => currentConfig;
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
    const entered = createDeferred<ChildExecution & { tools: string[] }>();
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      try {
        const admitted = await resolvePreparedRunAdmission({
          runId: params.runId,
          runtimeKind: "embedded",
          admittedRunContext: params.admittedRunContext,
          preparedRunAdmission: params.preparedRunAdmission,
        });
        const tools = await createOpenClawCodingToolsInternalAsync({
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          requesterOrigin: params.requesterOrigin,
          senderId: params.senderId,
          senderIsOwner: params.senderIsOwner,
          workspaceDir: params.workspaceDir,
          operationalRunInstance: admitted.operationalRunInstance,
          pluginExecutionAuthority: readAdmittedRunOperatorAuthority(admitted),
          toolConstructionPlan: {
            includeBaseCodingTools: true,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: false,
            includePluginTools: false,
          },
        });
        entered.resolve({
          admitted,
          signal: expectDefined(params.abortSignal, "queued child execution signal"),
          requesterOrigin: params.requesterOrigin,
          tools: tools.map((tool) => tool.name),
        });
        return await modelRun.promise;
      } catch (error) {
        entered.reject(error);
        throw error;
      }
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
            allowCollaborativeSteering: true,
            sessionKey: parentSessionKey,
            sessionId: "parent-session",
            runId: parentRunId,
            admittedRunContext: bound.admitted,
            gatewayContextResolver: () => context,
            controllerInput: expectDefined(getRpcSource(parentRunId), "parent controller source")
              .input,
          },
          async (turn) => {
            const steered = await turn.steer({
              profileId: "bob",
              senderId: "bob",
              name: "Bob",
              operatorAuthority: bobSource.authority,
            });
            expect(steered, JSON.stringify(steered)).toMatchObject({
              status: "accepted",
            });
            const result = await createBoundSpawnInvocation(bound, {
              collect: true,
              groupId,
              context: "isolated",
              user: "bob",
            })();
            expect(result.details, JSON.stringify(result)).toMatchObject({ status: "accepted" });
            expect(runEmbeddedAgent).not.toHaveBeenCalled();
            currentConfig = {
              ...bound.cfg,
              tools: { ...bound.cfg.tools, deny: ["write"] },
            };
            setRuntimeConfigSnapshot(currentConfig);
            advancePreparedModelRuntimeConfig(currentConfig);
            await turn.complete();
            bound.admission.close();
            bound.parent.cleanup();
            aliceSource.closeRequest();
            bobSource.closeRequest();
            expect(bobSource.holds).toBeGreaterThan(0);
            expect(releaseSwarmRun("participant-capacity")).toBe(true);
            const { admitted, requesterOrigin, tools, signal } = await entered.promise;
            expect(requesterOrigin).toMatchObject({
              operatorProfileId: "bob",
              senderId: "bob",
              messageProvider: "webchat",
              conversationId: parentSessionKey,
            });
            expect(tools).toContain("read");
            expect(tools).not.toContain("write");
            const childAuthority = expectDefined(
              readAdmittedRunOperatorAuthority(admitted),
              "queued child operator",
            );
            expect(childAuthority.profileId).toBe("bob");
            expect(() => childAuthority.assertCurrent()).not.toThrow();
            bobSource.revoke();
            expect(() => childAuthority.assertCurrent()).toThrow("operator source revoked");
            expect(signal.aborted).toBe(true);
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

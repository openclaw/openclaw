import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
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

export type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
export type SpawnBoundaryOptions = {
  createBoundParent: (authority?: AdmittedRunOperatorAuthority) => Promise<BoundParent>;
  createBoundGateway: (bound: BoundParent) => Promise<{
    context: GatewayRequestContext;
    runtime: ReturnType<typeof createGatewayInstanceRuntime>;
  }>;
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>;
};
type ChildExecution = {
  admitted: AdmittedRunContext;
  signal: AbortSignal;
  requesterOrigin?: RequesterOrigin;
  tools: string[];
};
function participant(profileId: string, name: string) {
  const source = createSpawnOperatorSource(profileId);
  return {
    source,
    person: { profileId, senderId: profileId, name, operatorAuthority: source.authority },
  };
}

export function registerParticipantSpawnCases(
  options: SpawnBoundaryOptions & {
    parentSessionKey: string;
    parentRunId: string;
  },
) {
  const { createBoundParent, createBoundGateway, runEmbeddedAgent, parentSessionKey, parentRunId } =
    options;
  const closeParent = (bound: BoundParent) => {
    bound.admission.close();
    bound.parent.cleanup();
  };
  const expectOrigin = (origin: RequesterOrigin | undefined, profileId: string) =>
    expect(origin).toMatchObject({
      operatorProfileId: profileId,
      senderId: profileId,
      messageProvider: "webchat",
      conversationId: parentSessionKey,
    });
  it.each([
    { visible: false, queued: false },
    { visible: true, queued: false },
    { visible: false, queued: true },
  ])(
    "delegates participant custody (visible=$visible, queued=$queued)",
    async ({ visible, queued }) => {
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
      const { source: aliceSource, person: alice } = participant("alice", "Alice");
      const { source: bobSource, person: bob } = participant("bob", "Bob");
      const bound = await createBoundParent(aliceSource.authority);
      const parentEnvelope = expectDefined(
        envelopes.find((entry) => entry.runId === parentRunId),
        "parent admission",
      );
      const originalParentEnvelope = structuredClone(parentEnvelope);
      if (!queued) {
        assignSessionOwner(
          { agentId: "main", storePath: bound.storePath, sessionKey: parentSessionKey },
          {
            owner: { type: "human", id: "alice" },
            assignedBy: { type: "system", id: "fixture" },
          },
        );
        bound.cfg.tools = { ...bound.cfg.tools, sessions: { visibility: "all" } };
      }
      const { context, runtime } = await createBoundGateway(bound);
      let currentConfig = bound.cfg;
      const groupId = "participant-queued";
      if (queued) {
        context.getRuntimeConfig = () => currentConfig;
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
      }
      const modelResult = createDeferred<EmbeddedAgentRunResult>();
      let entered = createDeferred<ChildExecution>();
      const childSettlements: Promise<void>[] = [];
      const model: typeof import("../../embedded-agent.js").runEmbeddedAgent = async (params) => {
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
          const tools = queued
            ? await createOpenClawCodingToolsInternalAsync({
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
              })
            : [];
          entered.resolve({
            admitted,
            signal: expectDefined(params.abortSignal, "child execution signal"),
            requesterOrigin: params.requesterOrigin,
            tools: tools.map((tool) => tool.name),
          });
          return await modelResult.promise;
        } catch (error) {
          entered.reject(error);
          throw error;
        }
      };
      if (queued) {
        runEmbeddedAgent.mockImplementationOnce(model);
      } else {
        runEmbeddedAgent.mockImplementation(model);
      }
      const tool =
        !queued &&
        createSessionsSpawnTool({
          config: bound.cfg,
          agentSessionKey: parentSessionKey,
          requesterRunId: parentRunId,
          requesterTurnRunId: parentRunId,
        });
      const invoke = (user?: string) =>
        tool
          ? tool.execute!("participant-spawn", {
              task: "Bounded participant child",
              visible,
              context: "isolated",
              user,
            })
          : createBoundSpawnInvocation(bound, {
              collect: true,
              groupId,
              context: "isolated",
              user,
            })();
      const keys = () => listSessionEntryKeysReadOnly({ storePath: bound.storePath });
      const closeTurn = async (turn: { complete: () => Promise<void> }) => {
        await turn.complete();
        closeParent(bound);
        aliceSource.closeRequest();
        bobSource.closeRequest();
        expect(bobSource.holds).toBeGreaterThan(0);
      };
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
                expect(result.details).toMatchObject({ status: "accepted" });
                const details = result.details as {
                  childSessionKey: string;
                  runId: string;
                  owner?: { type: string; id: string };
                };
                const entry = queued
                  ? undefined
                  : expectDefined(
                      loadSessionEntry({
                        storePath: bound.storePath,
                        sessionKey: details.childSessionKey,
                      }),
                      "created child",
                    );
                const settled = visible
                  ? expectDefined(
                      getRpcSource(details.runId)?.input.settlement.promise,
                      "visible child custody",
                    )
                  : undefined;
                if (settled) {
                  childSettlements.push(settled);
                }
                if (queued) {
                  expect(runEmbeddedAgent).not.toHaveBeenCalled();
                  currentConfig = { ...bound.cfg, tools: { ...bound.cfg.tools, deny: ["write"] } };
                  setRuntimeConfigSnapshot(currentConfig);
                  advancePreparedModelRuntimeConfig(currentConfig);
                  await closeTurn(turn);
                  expect(releaseSwarmRun("participant-capacity")).toBe(true);
                }
                const child = await (settled
                  ? awaitGateBeforeSettlement(
                      entered.promise,
                      settled,
                      "Spawn execution finished before model entry",
                    )
                  : entered.promise);
                const { admitted, requesterOrigin, tools } = child;
                const authority = expectDefined(
                  readAdmittedRunOperatorAuthority(admitted),
                  "child operator",
                );
                expect(authority.profileId).toBe(profileId);
                expectOrigin(requesterOrigin, profileId);
                if (queued) {
                  expect(tools).toContain("read");
                  expect(tools).not.toContain("write");
                } else {
                  const envelope = expectDefined(
                    envelopes.find((candidate) => candidate.runId === details.runId),
                    "child admission",
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
                }
                return { ...child, authority };
              };
              const steered = await turn.steer(bob);
              expect(steered, JSON.stringify(steered)).toMatchObject({ status: "accepted" });
              if (!queued && !visible) {
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
                  message: "Run for the selected participant",
                  mode: "followup",
                  timeoutSeconds: 0,
                });
                expect(sent.details, JSON.stringify(sent)).toMatchObject({
                  status: "accepted",
                  targetDisposition: "queued",
                });
                const child = await entered.promise;
                expect(readAdmittedRunOperatorAuthority(child.admitted)?.profileId).toBe("bob");
                expectOrigin(child.requesterOrigin, "bob");
                expect(
                  envelopes.find(
                    (entry) => entry.contextId === child.admitted.executionIdentityToken?.contextId,
                  ),
                ).toMatchObject({
                  invoker: { state: "present", kind: "agent", rawPrincipalRef: "main" },
                  representedSubject: { state: "present", kind: "person", rawPrincipalRef: "bob" },
                });
                expect(parentEnvelope).toEqual(originalParentEnvelope);
              }
              if (!queued) {
                const existingKeys = await keys();
                await expect(invoke("unknown-profile")).rejects.toThrow(/not a participant/i);
                expect(await keys()).toEqual(existingKeys);
              }
              const bobChild = await spawn("bob", "bob");
              const aliceChild = queued ? undefined : await spawn(undefined, "alice");
              if (!queued) {
                await closeTurn(turn);
              }
              expect(() => bobChild.authority.assertCurrent()).not.toThrow();
              if (!queued) {
                expect(getAdmittedRunDelegatedAuthority(bobChild.admitted)).toBeDefined();
              }
              bobSource.revoke();
              expect(() => bobChild.authority.assertCurrent()).toThrow("operator source revoked");
              expect(bobChild.signal.aborted).toBe(true);
              if (aliceChild) {
                expect(() => aliceChild.authority.assertCurrent()).not.toThrow();
                expect(aliceChild.signal.aborted).toBe(false);
              }
            },
          ),
        );
      } finally {
        modelResult.resolve({ payloads: [{ text: "child complete" }], meta: { durationMs: 1 } });
        if (queued) {
          releaseSwarmRun("participant-capacity");
          await closeSwarmScheduler();
        }
        await Promise.all(childSettlements);
        await bound.execution.drain();
        await settleRootWork();
        runtime.close();
        closeParent(bound);
      }
    },
  );
}

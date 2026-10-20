import { expectDefined } from "@openclaw/normalization-core";
/** Admitted parent, worker, and registered spawn fixtures shared by recursive boundary proofs. */
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { placementTurnOwner } from "../../../gateway/worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "../../../gateway/worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../../../gateway/worker-environments/placement-test-fixtures.js";
import {
  bindWorkerTurnOwner,
  getWorkerTurnExecutionIdentityCapability,
} from "../../../gateway/worker-environments/placement-turn-claim-events.js";
import { withTimeout } from "../../../infra/fs-safe.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { normalizeAcceptedSessionSpawnResult } from "../../accepted-session-spawn.js";
import {
  resolvePreparedRunAdmission,
  readAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
} from "../../admitted-run-context.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { writeSubagentSessionEntry } from "../registry/subagent-registry.persistence.test-support.js";
import { readBoundExecutionState } from "./subagent-spawn.production-boundary.diagnostics.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

export async function recordSpawnBoundaryFinal(params: {
  storePath: string;
  sessionKey: string;
  runId: string;
  text: string;
}) {
  const entry = expectDefined(loadSessionEntry(params), "final reply session");
  await appendTranscriptMessage(
    { ...params, agentId: "main", sessionId: entry.sessionId },
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: params.text }],
        stopReason: "stop",
        __openclaw: { runId: params.runId },
      },
    },
  );
}

export function createSpawnOperatorSource(
  profileId = "spawn-operator",
  scopes = ["operator.read", "operator.write"],
  policy?: Pick<
    AdmittedRunOperatorAuthority,
    "modelPolicy" | "rolePolicy" | "readCurrentRoleAssignment"
  >,
) {
  const revocation = new AbortController();
  let requestOpen = true;
  let holds = 0;
  const assertCurrent = () => {
    revocation.signal.throwIfAborted();
    if (!requestOpen && holds === 0) {
      throw new Error("operator source has no live owner");
    }
  };
  const authority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes,
    ...policy,
    gatewayAccessGrant: null,
    source: {},
    signal: revocation.signal,
    assertCurrent,
    retain: () => {
      assertCurrent();
      holds += 1;
      let held = true;
      return () => {
        if (held) {
          held = false;
          holds -= 1;
        }
      };
    },
  });
  return {
    authority,
    closeRequest: () => {
      requestOpen = false;
    },
    revoke: () => revocation.abort(new Error("operator source revoked")),
    get holds() {
      return holds;
    },
  };
}

export async function createSpawnBoundaryParent(params: {
  stateDir: string;
  parentSessionKey: string;
  parentRunId: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}) {
  const { stateDir, parentSessionKey, parentRunId, operatorAuthority } = params;
  const cfg = await captureRuntimeConfigAsyncReader()();
  const storePath = await writeSubagentSessionEntry({
    stateDir,
    agentId: "main",
    sessionKey: parentSessionKey,
    defaultSessionId: "parent-session",
  });
  const execution = new AsyncWorkScope();
  const context = createChatAbortContext({
    trackExecution: <T>(run: () => T | Promise<T>) => execution.track(run),
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
  });
  const gatewayBinding = { current: context as unknown as GatewayRequestContext };
  const resolveGatewayContext = () => gatewayBinding.current;
  context.resolveGatewayContext = resolveGatewayContext;
  const admission = prepareAgentRunAdmission({
    cfg,
    operatorAuthority,
    operationalRunInstance: createOperationalRunInstanceRef(parentRunId),
    facts: {
      runId: parentRunId,
      agentId: "main",
      ingress: { kind: "system", boundary: "spawn-production-boundary-test", state: "present" },
    },
  });
  const parent = withPluginRuntimeGatewayRequestScope(
    { context: gatewayBinding.current, resolveGatewayContext, isWebchatConnect: () => false },
    () =>
      registerChatAbortController({
        target: captureSessionTarget({
          storeScope: storePath,
          sessionKey: parentSessionKey,
          incarnation: "parent-session",
          agentId: "main",
        }),
        runId: parentRunId,
        sessionKey: parentSessionKey,
        sessionId: "parent-session",
        agentId: "main",
        ownerConnId: "owner-connection",
        timeoutMs: 60_000,
        operationalRunInstance: admission.operationalRunInstance,
      }),
  );
  const admitted = await admission.admit("embedded");
  bindGatewayContextResolver(admitted, resolveGatewayContext);
  const authority = getAdmittedRunDelegatedAuthority(admitted)!;
  parent.bindAgentRunDelegatedAuthority(authority);
  return {
    cfg,
    storePath,
    context,
    admission,
    parent,
    admitted,
    gatewayBinding,
    resolveGatewayContext,
    execution,
    parentSessionKey,
    parentRunId,
  };
}

export async function createBoundWorker(
  bound: Awaited<ReturnType<typeof createSpawnBoundaryParent>>,
) {
  const { parentSessionKey, parentRunId } = bound;
  const database = openOpenClawStateDatabase();
  const store = createWorkerSessionPlacementStore({ database });
  const session = { sessionId: "parent-session", agentId: "main", sessionKey: parentSessionKey };
  let placement = await store.startDispatch({ ...session, executionMode: "worker-turn" });
  placement = await store.transition({
    sessionId: session.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: "queued-worker-environment" },
  });
  placement = await store.transition({
    sessionId: session.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: "a".repeat(64) },
  });
  placement = await store.transition({
    sessionId: session.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: {
      workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
      remoteWorkspaceDir: "/workspace/queued-worker",
    },
  });
  seedAttachedPlacementEnvironment(database, {
    environmentId: "queued-worker-environment",
    sessionId: session.sessionId,
    ownerEpoch: 1,
  });
  placement = await store.transition({
    sessionId: session.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: 1 },
  });
  if (placement.state !== "active") {
    throw new Error("expected the active worker placement");
  }
  const claim = await store.claimTurn({
    ...session,
    owner: placementTurnOwner(placement),
    claimId: "queued-worker-claim",
    runId: parentRunId,
  });
  await bindWorkerTurnOwner(
    store,
    claim,
    bound.admitted.executionIdentityToken,
    bound.admission.operationalRunInstance,
    { ...session, storePath: bound.storePath },
    () => {
      if (!getAdmittedRunDelegatedAuthority(bound.admitted)) {
        throw new Error("worker parent no longer active");
      }
    },
  );
  const capability = getWorkerTurnExecutionIdentityCapability(store, claim);
  if (!capability) {
    throw new Error("expected the admitted worker capability");
  }
  return { store, session, claim, capability };
}

export function createBoundSpawnInvocation(
  bound: Awaited<ReturnType<typeof createSpawnBoundaryParent>>,
  request?: {
    collect?: true;
    groupId?: string;
    context?: "isolated" | "fork";
    user?: string;
    visible?: boolean;
    projectId?: string;
    worktree?: boolean;
    worktreeName?: string;
    worktreeBaseRef?: string;
    cleanup?: "keep" | "delete";
    expectsCompletionMessage?: boolean;
    completionTarget?: "parent";
    thinking?: string;
  },
  requesterModel?: { provider: string; model: string },
  senderIsOwner?: boolean,
) {
  const { parentSessionKey, parentRunId } = bound;
  const source = createSessionsSpawnTool({
    config: bound.cfg,
    senderIsOwner,
    expectedParentSessionId: "parent-session",
    agentSessionKey: parentSessionKey,
    requesterRunId: parentRunId,
    requesterTurnRunId: parentRunId,
    requesterModel,
  });
  let tool = source;
  if (request?.collect) {
    const [finalized] = finalizeAgentTools({
      tools: [
        source,
        createAgentsWaitTool({
          config: bound.cfg,
          agentSessionKey: parentSessionKey,
          agentId: "main",
        }),
      ],
      hookContext: {
        config: bound.cfg,
        agentId: "main",
        sessionKey: parentSessionKey,
        runId: parentRunId,
      },
      abortSignal: bound.parent.controller.signal,
    });
    if (!finalized) {
      throw new Error("expected the finalized spawn tool");
    }
    tool = finalized;
  }
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: bound.admitted,
    agentId: "main",
    sessionKey: parentSessionKey,
  });
  return (toolCallId = "spawn-production-boundary") =>
    withPluginRuntimeGatewayRequestScope(
      {
        context: bound.context as unknown as GatewayRequestContext,
        isWebchatConnect: () => false,
      },
      () =>
        withGatewayToolCallerIdentity(caller, () =>
          tool.execute!(toolCallId, { task: "bounded child", ...request }),
        ),
    );
}

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
type GatewayRuntime = ReturnType<typeof createGatewayInstanceRuntime>;

export type NativePluginSpawnTestOptions = {
  createBoundParent: (
    authority?: AdmittedRunOperatorAuthority,
    settings?: { guestProfileId?: string },
  ) => Promise<BoundParent>;
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
  settleRootWork: (keepObserving?: boolean) => Promise<void>;
  throwBoundFailures: (failures: unknown[]) => void;
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>;
};

// Two loaded exact-head CI runs reached this cold model boundary in 28–37 seconds.
const COLD_MODEL_ENTRY_TIMEOUT_MS = 60_000;

/** Creates the shared embedded-entry waiter around the suite's model mock. */
export function createEmbeddedRunWaiter(
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>,
) {
  return async (bound: BoundParent, childRunId: string, started?: Promise<void>, calls = 1) => {
    try {
      if (started) {
        await withTimeout(started, COLD_MODEL_ENTRY_TIMEOUT_MS, {
          message: "embedded execution entry timed out",
        });
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(calls);
      } else {
        await vi.waitFor(() => expect(runEmbeddedAgent).toHaveBeenCalledTimes(calls), {
          timeout: 15_000,
        });
      }
    } catch (cause) {
      throw new Error(
        `Embedded execution did not arrive: ${JSON.stringify(readBoundExecutionState(bound, childRunId))}`,
        { cause },
      );
    }
  };
}

export async function prepareIsolatedChildAdmissionProof(bound: BoundParent) {
  const { parentSessionKey, storePath } = bound;
  await appendTranscriptMessage(
    { storePath, sessionKey: parentSessionKey, sessionId: "parent-session" },
    { message: { role: "user", content: "History belonging only to the parent" } },
  );
  let createdChild: ReturnType<typeof loadSessionEntry>;
  spawnTesting.setDepsForTest({
    dispatchGatewayMethodInProcess: async <T>(
      method: string,
      params: Record<string, unknown>,
      dispatchOptions?: Parameters<typeof dispatchGatewayMethodInProcess>[2],
    ) => {
      if (method === "agent") {
        const scope = { storePath, sessionKey: String(params.sessionKey) };
        createdChild = expectDefined(loadSessionEntry(scope), "committed child before admission");
        expect(createdChild).toMatchObject({
          createdVia: "spawn",
          createdActor: { type: "agent", id: "main" },
          createdAt: expect.any(Number),
          spawnedBy: parentSessionKey,
          parentSessionKey,
          completionOwnerSessionKey: parentSessionKey,
        });
        expect(createdChild.sessionId).not.toBe("parent-session");
        expect(await loadTranscriptEvents({ ...scope, sessionId: createdChild.sessionId })).toEqual(
          [],
        );
        // A write after creation must survive adoption of the creation receipt.
        await upsertSessionEntryCore(scope, {
          label: "updated before admission",
          permissionMode: "read-only",
          thinkingLevel: "high",
        });
      }
      return await dispatchGatewayMethodInProcess<T>(method, params, dispatchOptions);
    },
  });
  return {
    assertAdmitted(
      childSessionKey: string,
      embeddedRun:
        | Parameters<typeof import("../../embedded-agent.js").runEmbeddedAgent>[0]
        | undefined,
    ) {
      const initialChild = expectDefined(createdChild, "created child identity");
      expect(embeddedRun).toMatchObject({
        sessionId: initialChild.sessionId,
        permissionMode: "read-only",
        thinkLevel: "high",
      });
      const admittedChild = expectDefined(
        loadSessionEntry({ storePath, sessionKey: childSessionKey }),
        "admitted child",
      );
      expect(admittedChild).toMatchObject({
        sessionId: initialChild.sessionId,
        lifecycleRevision: initialChild.lifecycleRevision,
        createdAt: initialChild.createdAt,
        createdVia: "spawn",
        createdActor: { type: "agent", id: "main" },
        parentSessionKey,
        completionOwnerSessionKey: parentSessionKey,
        label: "updated before admission",
        permissionMode: "read-only",
        thinkingLevel: "high",
      });
      return admittedChild;
    },
    restore: () => spawnTesting.setDepsForTest(),
  };
}

export type RequestCustodySpawnCaseOptions = {
  createBoundParent: () => Promise<BoundParent>;
  createBoundGateway: (bound: BoundParent) => Promise<{ runtime: GatewayRuntime }>;
  closeBoundGateway: (
    bound: BoundParent,
    runtime: GatewayRuntime,
    childRunId?: string,
  ) => Promise<unknown[]>;
  throwBoundFailures: (failures: unknown[]) => void;
  parentSessionKey: string;
  parentRunId: string;
  assertNoModelExecution: () => void;
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>;
};

export function registerYieldedRequesterBatchCase(options: {
  createBoundParent: () => Promise<BoundParent>;
  createGuestParent: (audit?: boolean) => Promise<{
    bound: BoundParent;
    source: ReturnType<typeof createSpawnOperatorSource>;
  }>;
  createBoundGateway: (bound: BoundParent) => Promise<{
    context: GatewayRequestContext;
    runtime: GatewayRuntime;
  }>;
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
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>;
  throwBoundFailures: (failures: unknown[]) => void;
}) {
  it.for(["system", "guest"] as const)(
    "continues a yielded nested parent once through its accepted child batch (%s)",
    async (actor, { signal }) => {
      const registry = await import("../registry/subagent-registry.js");
      const { loadSubagentRegistryFromSqlite } =
        await import("../registry/subagent-registry-state.fixture.test-support.js");
      const { settleSubagentRegistryPersistenceWork } =
        await import("../registry/subagent-registry.persistence.test-support.js");
      const announce = await import("../announce/subagent-announce.js");
      const nativeAnnounce = await vi.importActual<typeof announce>(
        "../announce/subagent-announce.js",
      );
      vi.mocked(announce.runSubagentAnnounceFlow).mockImplementation(
        nativeAnnounce.runSubagentAnnounceFlow,
      );
      const guest = actor === "guest" ? await options.createGuestParent(false) : undefined;
      const bound = guest?.bound ?? (await options.createBoundParent());
      const { context, runtime } = await options.createBoundGateway(bound);
      const delivery = await import("../announce/subagent-announce-delivery.js");
      const deliver = delivery.deliverSubagentAnnouncement;
      const delivered = createDeferred<Awaited<ReturnType<typeof deliver>>>();
      const deliveryObserver = vi
        .spyOn(delivery, "deliverSubagentAnnouncement")
        .mockImplementation(async (params) => {
          const result = await deliver(params);
          if (
            params.sourceTool === "subagent_settle" &&
            params.requesterSessionKey === bound.parentSessionKey
          ) {
            delivered.resolve(result);
          }
          return result;
        });
      const childStarted = createDeferred();
      const childResult = createDeferred<EmbeddedAgentRunResult>();
      const parentStarted = createDeferred();
      const parentCalls: Array<{
        runId: string;
        childSessionKey: string | undefined;
        hasAuthority: boolean;
        prompt: string;
      }> = [];
      const admissionFailures: unknown[] = [];
      options.runEmbeddedAgent.mockImplementation(async (params) => {
        try {
          const admitted = await resolvePreparedRunAdmission({
            runId: params.runId,
            runtimeKind: "embedded",
            admittedRunContext: params.admittedRunContext,
            preparedRunAdmission: params.preparedRunAdmission,
          });
          if (guest) {
            const authority = readAdmittedRunOperatorAuthority(admitted);
            expect(authority?.profileId).toBe(guest.source.authority.profileId);
            expect(authority?.scopes).toEqual(["operator.sessions.write"]);
            expect(authority?.modelPolicy).toBe(guest.source.authority.modelPolicy);
          }
          await params.onExecutionStarted?.();
          if (params.sessionKey !== bound.parentSessionKey) {
            childStarted.resolve();
            const result = await childResult.promise;
            await recordSpawnBoundaryFinal({
              storePath: bound.storePath,
              sessionKey: expectDefined(params.sessionKey, "child session"),
              runId: params.runId,
              text: "Nested child result.",
            });
            return result;
          }
          const current = subagentRuns.get(params.runId);
          parentCalls.push({
            runId: params.runId,
            childSessionKey: current?.childSessionKey,
            hasAuthority: getAdmittedRunDelegatedAuthority(admitted) !== undefined,
            prompt: params.prompt,
          });
          parentStarted.resolve();
          await recordSpawnBoundaryFinal({
            storePath: bound.storePath,
            sessionKey: bound.parentSessionKey,
            runId: params.runId,
            text: "Nested parent is complete.",
          });
          return {
            payloads: [{ text: "Nested parent is complete." }],
            meta: {
              durationMs: 1,
              terminalReply: { disposition: "visible", text: "Nested parent is complete." },
            },
          };
        } catch (error) {
          admissionFailures.push(error);
          (params.sessionKey === bound.parentSessionKey ? parentStarted : childStarted).resolve();
          throw error;
        }
      });
      let childRunId: string | undefined;
      const failures: unknown[] = [];
      try {
        await registry.registerSubagentRun({
          runId: bound.parentRunId,
          childSessionKey: bound.parentSessionKey,
          childAgentId: "main",
          sessionEntry: expectDefined(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: bound.parentSessionKey }),
            "registered parent session",
          ),
          requesterSessionKey: "agent:main:main",
          requesterAgentId: "main",
          requesterDisplayKey: "main",
          task: "Continue after an accepted child completes",
          cleanup: "keep",
          expectsCompletionMessage: false,
          gatewayContextResolver: () => context,
        });
        const spawned = await createBoundSpawnInvocation(bound, {
          context: "isolated",
          ...(guest ? { completionTarget: "parent" as const } : {}),
        })();
        const accepted = expectDefined(
          normalizeAcceptedSessionSpawnResult(spawned),
          "actual accepted spawn",
        );
        expect(accepted.expectsCompletionMessage).toBe(true);
        childRunId = accepted.runId;
        await options.waitForEmbeddedRun(bound, childRunId, childStarted.promise);
        expect(
          await registry.markRequesterTurnYielded({
            requesterSessionKey: bound.parentSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId: bound.parentRunId,
          }),
        ).toBe(1);
        expect(
          await registry.settleRequesterAfterSessionSpawns({
            requesterSessionKey: bound.parentSessionKey,
            requesterTurnRunId: bound.parentRunId,
            requesterYielded: true,
            acceptedSessionSpawns: [accepted],
          }),
        ).toBe(true);
        expect(subagentRuns.get(bound.parentRunId)?.pauseReason).toBe("sessions_yield");
        expect(subagentRuns.get(childRunId)?.requesterSettleWake).toMatchObject({
          requesterYieldBatch: true,
          rearmGeneration: 1,
          batchRunIds: [childRunId],
        });
        bound.admission.close();
        bound.parent.cleanup();
        guest?.source.closeRequest();
        childResult.resolve({
          payloads: [{ text: "Nested child result." }],
          meta: {
            durationMs: 1,
            terminalReply: { disposition: "visible", text: "Nested child result." },
          },
        });
        const deliveryResult = await withinTest(delivered.promise, signal);
        expect(deliveryResult, JSON.stringify(deliveryResult)).toMatchObject({ delivered: true });
        await options.waitForEmbeddedRun(bound, bound.parentRunId, parentStarted.promise, 2);
        await settleSubagentRegistryPersistenceWork();
        expect(admissionFailures).toEqual([]);
        expect(parentCalls).toHaveLength(1);
        expect(parentCalls[0]).toMatchObject({
          childSessionKey: bound.parentSessionKey,
          hasAuthority: true,
        });
        expect(parentCalls[0]?.prompt).toContain("Nested child result.");
        const durable = loadSubagentRegistryFromSqlite().get(childRunId);
        expect(durable?.delivery?.status).toBe("delivered");
        expect(durable?.requesterSettleWake).toBeUndefined();
      } catch (error) {
        failures.push(error);
      } finally {
        childResult.resolve({
          payloads: [{ text: "Nested child result." }],
          meta: {
            durationMs: 1,
            terminalReply: { disposition: "visible", text: "Nested child result." },
          },
        });
        deliveryObserver.mockRestore();
        failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
        options.throwBoundFailures(failures);
      }
    },
  );
}

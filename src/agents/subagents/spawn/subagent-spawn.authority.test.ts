import "./subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { installSpawnAuthorityFixture, waitForSubagentCleanupCompleted, observeSubagentRun } from "./subagent-spawn.authority.test-support.js";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../../acp/control-plane/manager.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../../acp/runtime/registry.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { resolveMcpLoopbackScopedTools } from "../../../gateway/mcp-http.runtime.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import { invokeChatAbortHandler } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionEffect,
  consumeSessionEffectHandoff,
} from "../../../sessions/session-controller.lifecycle.js";
import { observeSessionWorkAdmissionDrain } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
} from "../../admitted-run-context.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { buildCliMcpGrantContext } from "../../cli-runner/mcp-grant-context.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { killSubagentRunAdmin } from "../registry/subagent-control.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun } from "../registry/subagent-registry.js";
import {
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "../registry/subagent-run-generation.js";
import { resolveSubagentSessionStatus } from "../registry/subagent-session-metrics.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { spawnAcpDirect } from "./acp-spawn.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

vi.mock("../../../browser-lifecycle-cleanup.js", { spy: true });

const fixture = installSpawnAuthorityFixture();
const { parentSessionKey, parentRunId, groupId, createBoundParent } = fixture;
type Bound = Awaited<ReturnType<typeof createBoundParent>>;
const observe = (pending: Promise<unknown>) => pending.catch((error: unknown) => error);
const abortParent = (context: Bound["context"], scopes = ["operator.write"]) =>
  invokeChatAbortHandler({
    handler: handleChatAbortRequest,
    context,
    request: { sessionKey: parentSessionKey, runId: parentRunId },
    client: { connId: "owner-connection", connect: { scopes } },
  });

function inGateway<T>(context: Bound["context"], work: () => T) {
  return withPluginRuntimeGatewayRequestScope(
    { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
    work,
  );
}

function asCaller<T>(
  context: Bound["context"],
  admitted: Bound["admitted"],
  sessionKey: string,
  work: () => T,
) {
  return inGateway(context, () =>
    withGatewayToolCallerIdentity(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey,
      }),
      work,
    ),
  );
}

async function blockSpawn(sessionKey: string, runId: string) {
  const started = createDeferred();
  enqueueSwarmRun({
    groupId: JSON.stringify(["main", sessionKey, groupId]),
    runId,
    maxConcurrent: 1,
    activeRunIds: [],
    start: async () => started.resolve(),
    onStartFailure: () => true,
  });
  await started.promise;
}

function spawnTool(
  cfg: Bound["cfg"],
  sessionKey: string,
  runId: string,
  abortSignal: AbortSignal,
  decorate: (source: AnyAgentTool) => AnyAgentTool = (source) => source,
) {
  const source = createSessionsSpawnTool({
    config: cfg,
    agentSessionKey: sessionKey,
    requesterRunId: runId,
    requesterTurnRunId: runId,
  });
  return finalizeAgentTools({
    tools: [
      decorate(source),
      createAgentsWaitTool({ config: cfg, agentSessionKey: sessionKey, agentId: "main" }),
    ],
    hookContext: { config: cfg, agentId: "main", sessionKey, runId },
    abortSignal,
  })[0]!;
}

function installDispatch(
  dispatch?: (params: Record<string, unknown>) => void,
  rollback?: () => Promise<void>,
  inProcess = false,
) {
  spawnTesting.setDepsForTest({
    ...(inProcess ? { hasInProcessGatewayContext: () => true } : {}),
    resolveContextEngine: async () =>
      Object.assign(
        new LegacyContextEngine(),
        rollback ? { prepareSubagentSpawn: async () => ({ rollback }) } : {},
      ),
    dispatchGatewayMethodInProcess: async <T>(method: string, params: Record<string, unknown>) => {
      expect(method).toBe("agent");
      dispatch?.(params);
      return { runId: params.idempotencyKey, status: "accepted" } as T;
    },
  });
}

describe("pending spawn invocation authority", () => {
  it.each(["sibling", "nested sibling"] as const)(
    "stops a fresh spawn below a completed persistent sibling while a %s drain remains pending",
    async (slowBranch) => {
      const originalConfig = getRuntimeConfig();
      const config = {
        ...originalConfig,
        agents: {
          ...originalConfig.agents,
          defaults: {
            ...originalConfig.agents?.defaults,
            subagents: { maxSpawnDepth: 2 },
          },
        },
      };
      await fixture.configure(config);
      const { cfg, storePath, context, admission, parent } = await createBoundParent();
      const key = (id: string) => `agent:main:subagent:${id}`;
      const ids = slowBranch === "sibling" ? ["a", "b"] : ["a", "b", "d"];
      const slowId = slowBranch === "sibling" ? "a" : "d";
      for (const id of ids) {
        await fixture.writeSession(key(id), `${id}-session`, "main", "original");
        await registerSubagentRun({
          runId: id,
          childSessionKey: key(id),
          childAgentId: "main",
          sessionEntry: { sessionId: `${id}-session`, lifecycleRevision: "original" },
          controllerSessionKey: id === "d" ? key("a") : parentSessionKey,
          requesterSessionKey: id === "d" ? key("a") : parentSessionKey,
          requesterAgentId: "main",
          requesterDisplayKey: parentSessionKey,
          requesterTurnRunId: id === "d" ? "a" : parentRunId,
          task: id,
          cleanup: "keep",
          collect: id !== "b",
          spawnMode: id === "b" ? "session" : "run",
          expectsCompletionMessage: false,
        });
        registerAgentRunContext(id, { sessionKey: key(id), sessionId: `${id}-session` });
      }
      const registeredB = subagentRuns.get("b")!;
      const completedGeneration = registeredB.generation;
      const cleanupEntered = createDeferred();
      const releaseCleanup = createDeferred();
      const cleanupBrowser = vi.mocked(cleanupBrowserSessionsForLifecycleEnd);
      const originalCleanup = cleanupBrowser.getMockImplementation()!;
      cleanupBrowser.mockImplementation(async (params) => {
        if (params.sessionKeys.includes(key("b"))) {
          cleanupEntered.resolve();
          await releaseCleanup.promise;
        }
        await originalCleanup(params);
      });
      let cleanup: Promise<void> | undefined;
      try {
        emitAgentEvent({
          runId: "b",
          sessionKey: key("b"),
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now() },
        });
        await cleanupEntered.promise;
        expect(resolveSubagentSessionStatus(subagentRuns.get("b"))).toBe("done");
        expect(subagentRuns.get("b")?.cleanupCompletedAt).toBeUndefined();
        let ready = false;
        cleanup = waitForSubagentCleanupCompleted(registeredB).then(() => {
          ready = true;
        });
        // Imports can be idle while completion still has not scheduled its cleanup tails.
        await vi.dynamicImportSettled();
        expect(ready, "task success is not cleanup readiness").toBe(false);
      } finally {
        releaseCleanup.resolve();
        await cleanup;
        cleanupBrowser.mockImplementation(originalCleanup);
      }
      clearAgentRunContext("b");
      await fixture.settle();
      const completedB = subagentRuns.get("b")!;
      expect(completedB).toMatchObject({
        generation: completedGeneration,
        cleanupCompletedAt: expect.any(Number),
        spawnMode: "session",
        execution: { status: "terminal" },
        endedReason: "subagent-complete",
      });
      expect(
        Array.from(subagentRuns.values()).some((entry) => entry.controllerSessionKey === key("b")),
      ).toBe(false);
      const entered = createDeferred();
      const resume = createDeferred();
      const slow = await beginSessionEffect({
        scope: storePath,
        identities: [key(slowId), `${slowId}-session`],
        assertAllowed: () => {},
        onInterrupt: () => slow.release(),
      });
      const restoreDrain = observeSessionWorkAdmissionDrain(async (params, released) => {
        const matchesSlowTarget =
          "target" in params
            ? params.target.storeScope === storePath && params.target.aliases.includes(key(slowId))
            : params.scope === storePath && Array.from(params.identities).includes(key(slowId));
        if (matchesSlowTarget) {
          expect(released).toBe(true);
          entered.resolve();
          await resume.promise;
        }
      });
      const cancellation = abortParent(context);
      const freshAdmission = prepareSystemAgentRunAdmission(
        cfg,
        "fresh-b",
        "main",
        "spawn-authority-test",
      );
      let fresh: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
      const freshInterrupted = vi.fn();
      const dispatch = vi.fn();
      const expectCompletedSibling = () => {
        expect(isSameSubagentRunOwner(subagentRuns.get("b"), completedB)).toBe(true);
        expect(subagentRuns.get("b")?.generation).toBe(completedGeneration);
        expect(resolveSubagentSessionStatus(subagentRuns.get("b"))).toBe("done");
        expect(loadSessionEntry({ storePath, sessionKey: key("b") })).toMatchObject({
          sessionId: "b-session",
          lifecycleRevision: "original",
        });
      };
      try {
        // The sibling drain and B's delivery bookkeeping publish independently.
        await entered.promise;
        expectCompletedSibling();
        const admitted = await freshAdmission.admit("embedded");
        bindGatewayContextResolver(admitted, () => context as unknown as GatewayRequestContext);
        fresh = await beginSessionEffect({
          scope: storePath,
          identities: [key("b"), "b-session"],
          assertAllowed: () => {},
          onInterrupt: () => {
            freshInterrupted();
            fresh?.release();
          },
        });
        await blockSpawn(key("b"), "late-spawn-blocker");
        installDispatch(dispatch);
        const tool = spawnTool(cfg, key("b"), "fresh-b", new AbortController().signal);
        const spawned = await fresh.run(() =>
          asCaller(context, admitted, key("b"), () =>
            tool.execute!("late-spawn", {
              task: "late child",
              collect: true,
              context: "isolated",
              groupId,
            }),
          ),
        );
        expect(spawned).toMatchObject({ details: { status: "accepted" } });
        const { runId } = spawned.details as { runId: string };
        expect(subagentRuns.get(runId)).toMatchObject({
          controllerSessionKey: key("b"),
          requesterTurnRunId: "fresh-b",
          execution: { status: "queued" },
        });
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeDefined();
        resume.resolve();
        expect(await cancellation).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ aborted: true }),
        );
        expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe("killed");
        expectCompletedSibling();
        expect(freshInterrupted).not.toHaveBeenCalled();
        expect(fresh.isActive()).toBe(true);
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeDefined();
        releaseSwarmRun("late-spawn-blocker");
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        slow.release();
        fresh?.release();
        try {
          await cancellation;
        } finally {
          restoreDrain();
          releaseSwarmRun("late-spawn-blocker");
          freshAdmission.close();
          admission.close();
          parent.cleanup();
          ids.forEach((id) => clearAgentRunContext(id));
        }
      }
    },
  );

  it("settles child ownership when the parent aborts during registration", async () => {
    const { cfg, context, admission, parent, admitted } = await createBoundParent();
    await blockSpawn(parentSessionKey, "handoff-blocker");
    let cancellation: ReturnType<typeof invokeChatAbortHandler> | undefined;
    const cancel = () => abortParent(context, ["operator.read", "operator.write"]);
    let registrationAbortRequested = false;
    const stopObservingRegistration = subscribeSubagentRunChanges("persistence", () => {
      if (
        !registrationAbortRequested &&
        [...subagentRuns.values()].some(
          (run) => run.requesterTurnRunId === parentRunId && run.queuedLaunch !== undefined,
        )
      ) {
        registrationAbortRequested = true;
        cancellation = cancel();
      }
    });
    const rollback = vi.fn(async () => {});
    const dispatch = vi.fn();
    installDispatch(dispatch, rollback);
    let forwarded: Promise<unknown> | undefined;
    const tool = spawnTool(cfg, parentSessionKey, parentRunId, parent.controller.signal, (source) =>
      copyAgentToolMetadata(source, {
        ...source,
        execute: (...args) => {
          const pending = source.execute!(...args);
          forwarded = observe(pending);
          return pending;
        },
      }),
    );
    const pending = observe(
      asCaller(context, admitted, parentSessionKey, () =>
        tool.execute!("spawn-handoff", {
          task: "independent after handoff",
          collect: true,
          context: "isolated",
          groupId,
        }),
      ),
    );
    try {
      await pending;
      // The source can finish its handoff even when the outer native wrapper is aborted.
      const accepted = await forwarded;
      expect(accepted).toMatchObject({ details: { status: "accepted" } });
      expect(registrationAbortRequested).toBe(true);
      const { runId } = (accepted as { details: { runId: string } }).details;
      expect(subagentRuns.get(runId)?.requesterTurnRunId).toBe(parentRunId);
      expect(dispatch).not.toHaveBeenCalled();
      cancellation ??= cancel();
      const respond = await cancellation;
      expect(respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: [parentRunId],
      });
      expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
      // Capacity is released by Gateway-owned work, outside the completed parent's caller.
      inGateway(context, () => releaseSwarmRun("handoff-blocker"));
      expect(dispatch).not.toHaveBeenCalled();
      expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe("killed");
      expect(subagentRuns.get(runId)).toMatchObject({
        collectorCompletion: { status: "killed" },
      });
    } finally {
      releaseSwarmRun("handoff-blocker");
      stopObservingRegistration();
      await cancellation;
      await forwarded;
      await pending;
      admission.close();
      parent.cleanup();
    }
  });

  it("cancels the task's captured row when delayed acceptance rekeys it during the drain", async () => {
    const { cfg, storePath, context, admission, parent } = await createBoundParent();
    const response = createDeferred();
    const dispatchEntered = createDeferred();
    spawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(method: string) => {
        expect(method).toBe("agent");
        dispatchEntered.resolve();
        await response.promise;
        return { runId: "accepted-task-run", status: "accepted" } as T;
      },
    });
    let lease: ReturnType<typeof consumeSessionEffectHandoff>;
    let cancellation: ReturnType<typeof killSubagentRunAdmin> | undefined;
    try {
      const spawned = await inGateway(context, () =>
        spawnSubagentDirect(
          {
            task: "acceptance rekey",
            collect: true,
            context: "isolated",
            lightContext: true,
            groupId,
          },
          { agentSessionKey: parentSessionKey, requesterRunId: parentRunId },
        ),
      );
      expect(spawned.status).toBe("accepted");
      await dispatchEntered.promise;
      const entry = subagentRuns.get(spawned.runId!)!;
      const child = loadSessionEntry({ storePath, sessionKey: spawned.childSessionKey! })!;
      const identities = [spawned.childSessionKey!, child.sessionId];
      const work = await beginSessionEffect({
        scope: storePath,
        identities,
        run: {
          runId: entry.runId,
          sessionKey: entry.childSessionKey,
          sessionId: child.sessionId,
          agentId: entry.childAgentId,
        },
        assertAllowed: () => {},
      });
      const interrupted = createDeferred();
      lease = consumeSessionEffectHandoff({
        scope: storePath,
        identities,
        handoffId: work.createHandoff(),
        onInterrupt: () => {
          interrupted.resolve();
          return { runId: entry.runId };
        },
      });
      const { generation, createdAt, taskRunId, schedulerSlotId } = entry;
      const runtimeOwner = getSubagentRunRuntimeKey(entry);
      cancellation = killSubagentRunAdmin({
        cfg,
        sessionKey: spawned.childSessionKey!,
        expectedRunId: entry.runId,
        expectedTaskRunId: entry.taskRunId ?? entry.runId,
        expectedGeneration: entry.generation,
        expectedOwnerKey: parentSessionKey,
      });
      await awaitGateBeforeSettlement(
        interrupted.promise,
        cancellation,
        "Cancellation returned before drain",
      );
      const accepted = observeSubagentRun("accepted-task-run");
      try {
        response.resolve();
        const acceptedEntry = await awaitGateBeforeSettlement(
          accepted.promise,
          cancellation,
          "Cancellation returned before acceptance",
        );
        expect(acceptedEntry).toMatchObject({
          runId: "accepted-task-run",
          childSessionKey: entry.childSessionKey,
          generation,
          createdAt,
          taskRunId,
          schedulerSlotId,
        });
        expect(getSubagentRunRuntimeKey(acceptedEntry)).toBe(runtimeOwner);
        expect(subagentRuns.has(entry.runId)).toBe(false);
      } finally {
        accepted.stop();
      }
      lease?.release();
      const result = await cancellation;
      expect(result).toMatchObject({ found: true, killed: true });
      expect(subagentRuns.get("accepted-task-run")?.endedReason).toBe("subagent-killed");
    } finally {
      response.resolve();
      lease?.release();
      await cancellation;
      admission.close();
      parent.cleanup();
    }
  });
});

const { writeSession, configure } = fixture;
const backendId = "requester-incarnation-fixture";

function useInProcessSpawns(beforeDispatch?: (params: Record<string, unknown>) => void) {
  installDispatch(beforeDispatch, undefined, true);
}

function inspectChildCredit(profiles: string[] | undefined, checkActor = false) {
  return vi.fn(({ sessionKey }: Record<string, unknown>) => {
    if (typeof sessionKey !== "string") {
      throw new Error("Expected a child dispatch key");
    }
    const child = loadSessionEntryReadOnly({ agentId: "main", sessionKey });
    expect(child?.inheritedGitContributorProfileIds).toEqual(profiles);
    expect(child?.participants ?? []).toEqual([]);
    if (checkActor) {
      expect(child?.createdActor).toEqual({ type: "agent", id: "main" });
    }
  });
}

it("preserves a nonowner CLI requester's credit through mediated spawn", async () => {
  const { cfg, admitted, admission, parent } = await fixture.createBoundParent();
  try {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: fixture.parentSessionKey },
      { inheritedGitContributorProfileIds: ["unrelated-a", "unrelated-b"] },
    );
    const inspectChild = inspectChildCredit(["verified-cli-requester"], true);
    // Only model dispatch is external: grant projection, tool construction, and child writes are real.
    useInProcessSpawns(inspectChild);
    const context = buildCliMcpGrantContext({
      run: {
        sessionId: "parent-session",
        sessionKey: fixture.parentSessionKey,
        sessionFile: "unused-cli-transcript",
        workspaceDir: fixture.stateDir,
        provider: "fixture-cli",
        prompt: "Delegate this task",
        timeoutMs: 1_000,
        runId: fixture.parentRunId,
        senderIsOwner: false,
        gitContributorProfileId: "verified-cli-requester",
      },
      config: cfg,
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5.4",
      toolsAllow: ["sessions_spawn"],
    });
    const { tools } = await resolveMcpLoopbackScopedTools({
      cfg,
      context,
      admittedRunContext: admitted,
    });
    const spawn = tools.find((tool) => tool.name === "sessions_spawn");
    if (!spawn) {
      throw new Error("Expected the mediated spawn tool");
    }
    const result = await spawn.execute("cli-spawn-credit", { task: "Implement the CLI request" });
    expect(result.details).toMatchObject({ status: "accepted" });
    expect(inspectChild).toHaveBeenCalledOnce();
    expect(readAdmittedRunOperatorAuthority(admitted)).toBeUndefined();
  } finally {
    admission.close();
    parent.cleanup();
  }
});

it.each([false, true])(
  "plans children without host reads and sees committed requester preferences (proxied completion=%s)",
  async (proxiedCompletion) => {
    const completionOwnerKey = "agent:main:completion-owner";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: completionOwnerKey },
      {
        sessionId: "completion-owner",
        updatedAt: 1,
        sandbox: "required",
        createdActor: { type: "human", source: "profile", id: "completion-profile" },
      },
    );
    const request = { task: "inherit requester preferences", context: "isolated" as const };
    const ctx = {
      agentSessionKey: fixture.parentSessionKey,
      ...(proxiedCompletion ? { completionOwnerKey } : {}),
    };
    for (const [thinkingLevel, fastMode] of [
      ["low", false],
      ["high", true],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: fixture.parentSessionKey },
        { sessionId: "controller", updatedAt: 1, thinkingLevel, fastMode },
      );
      const preparation = await resolveSubagentSpawnRequest(request, ctx);
      if (!preparation.ok) {
        throw new Error(JSON.stringify(preparation.result));
      }
      const sql = observeHostDataSql();
      try {
        const plan = await resolveSubagentChildPlan({
          ...preparation.resolved,
          request,
          ctx,
          sandboxMode: "inherit",
          swarmEnabled: true,
        });
        expect(sql.queries).toEqual([]);
        if (!plan.ok) {
          throw new Error(JSON.stringify(plan.result));
        }
        expect(plan.resolved).toMatchObject({
          childRuntimeSandboxed: false,
          creationPolicy: { actor: { type: "agent", id: "main" } },
          modelPlan: { initialSessionPatch: { thinkingLevel, fastMode } },
        });
      } finally {
        sql.restore();
        preparation.resolved.admissionReservation?.release();
      }
    }
  },
);

it("rejects a spawn cancelled during requester acquisition before starting effects", async () => {
  await writeSession(fixture.parentSessionKey, "cancelled-requester");
  const abort = new AbortController();
  const effectsStarted = vi.fn();
  const pending = spawnSubagentDirect(
    { task: "cancel before admission", context: "isolated" },
    {
      agentSessionKey: fixture.parentSessionKey,
      assertActive: () => abort.signal.throwIfAborted(),
      onSpawnEffectsStart: effectsStarted,
    },
  );
  abort.abort(new Error("requester acquisition cancelled"));
  expect(await pending).toEqual({
    status: "error",
    error: "sessions_spawn could not read the requester session: requester acquisition cancelled",
  });
  expect(effectsStarted).not.toHaveBeenCalled();
});

it.each(["native", "acp", "missing requester", "visible"] as const)(
  "keeps the birth requester window through async %s launch",
  async (scenario) => {
    const backend = scenario === "missing requester" ? "native" : scenario;
    const globalRequester = backend === "visible";
    const originalSessionId = scenario === "missing requester" ? undefined : "original-requester";
    const requesterKey = globalRequester ? "global" : "agent:main:completion-owner";
    const controllerKey = globalRequester
      ? "agent:main:dashboard:controller"
      : fixture.parentSessionKey;
    const originalRevision = originalSessionId ? "original-requester-lifecycle" : undefined;
    const replacement = {
      sessionId: "replacement-requester",
      lifecycleRevision: "replacement-requester-lifecycle",
    };
    if (globalRequester || backend === "acp") {
      const cfg = getRuntimeConfig();
      await configure({
        ...cfg,
        ...(globalRequester
          ? {
              session: { ...cfg.session, scope: "global" },
              agents: {
                ...cfg.agents,
                ownership: "explicit",
                entries: { main: { subagents: { allowAgents: ["worker"] } }, worker: {} },
              },
            }
          : {
              acp: { enabled: true, backend: backendId, allowedAgents: ["main"] },
              agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, model: undefined } },
            }),
      });
    }
    if (globalRequester) {
      await writeSession("global", "foreign-child-owner", "worker");
    }
    await writeSession(controllerKey, "controller-session");
    if (originalSessionId) {
      await writeSession(requesterKey, originalSessionId, "main", originalRevision);
    }
    if (backend === "acp") {
      managerTesting.resetAcpSessionManagerForTests();
      const runtime: AcpRuntime = {
        ownerAwareSessions: 1,
        async ensureSession({ sessionKey, agentId }) {
          return {
            sessionKey,
            agentId,
            backend: backendId,
            runtimeSessionName: sessionKey,
          };
        },
        runTurn() {
          throw new Error("No external harness turn belongs in this boundary test");
        },
        async cancel() {},
        async close() {},
      };
      registerAcpRuntimeBackend({ id: backendId, runtime });
    }
    useInProcessSpawns();
    const rotateRequester = vi.fn(() => {
      // Rotate after requester capture and before child creation; completion
      // must retain that captured window even when later launch steps await.
      replaceSessionEntrySync(
        { sessionKey: requesterKey, agentId: "main" },
        { ...replacement, updatedAt: Date.now() },
      );
    });
    const ctx = {
      agentSessionKey: controllerKey,
      completionOwnerKey: requesterKey,
      onSpawnEffectsStart: rotateRequester,
      ...(globalRequester ? { requesterAgentIdOverride: "main" } : {}),
    };
    try {
      const pending =
        backend === "native"
          ? spawnSubagentDirect({ task: "window-bound work", context: "isolated" }, ctx)
          : backend === "acp"
            ? spawnAcpDirect({ task: "window-bound work", agentId: "main", mode: "run" }, ctx)
            : maybeSpawnVisibleSession({
                raw: { visible: true },
                requestedAgentId: "worker",
                task: "window-bound work",
                label: "",
                runtime: "subagent",
                sandbox: "inherit",
                expectsCompletionMessage: true,
                options: {
                  ...ctx,
                  config: getRuntimeConfig(),
                  callGateway: async <T>(method: string) => {
                    if (method !== "sessions.create") {
                      throw new Error(`Unexpected visible spawn RPC ${method}`);
                    }
                    const childSessionKey = "agent:worker:dashboard:window-child";
                    await writeSession(childSessionKey, "visible-child-session", "worker");
                    return {
                      key: childSessionKey,
                      sessionId: "visible-child-session",
                      runStarted: true,
                      runId: "visible-child-run",
                    } as T;
                  },
                },
              });
      const result = await pending;
      expect(result).toMatchObject({ status: "accepted" });
      expect(rotateRequester).toHaveBeenCalled();
      const runId = result?.runId;
      if (typeof runId !== "string") {
        throw new Error("Expected an accepted child run");
      }
      await fixture.settle();
      const restored = loadSubagentRegistryFromSqlite().get(runId);
      expect(restored).toMatchObject({
        runId,
        requesterSessionKey: requesterKey,
        controllerSessionKey: controllerKey,
        expectsCompletionMessage: true,
      });
      expect(restored?.completionRequesterSessionId).toBe(originalSessionId);
      expect(restored?.completionRequesterLifecycleRevision).toBe(originalRevision);
      expect(loadSessionEntryReadOnly({ sessionKey: requesterKey, agentId: "main" })).toMatchObject(
        replacement,
      );
    } finally {
      if (backend === "acp") {
        await disposeAcpSessionManagerInstance(getAcpSessionManager(), "test-cleanup");
        managerTesting.resetAcpSessionManagerForTests();
        unregisterAcpRuntimeBackend(backendId);
      }
    }
  },
);

it("inherits accepted human credit when participant persistence is still queued", async () => {
  const agentId = "main";
  const sessionKey = fixture.parentSessionKey;
  // Dispatch sees initial child credit, before acceptance records its agent participant.
  const inspectChild = inspectChildCredit(["human-requester"]);
  useInProcessSpawns(inspectChild);
  const storePath = resolveOpenClawAgentSqlitePath({ agentId });
  const scope = { agentId, sessionKey, storePath };
  await upsertSessionEntryCore(scope, { sessionId: "parent-id", updatedAt: 1 });
  const releaseWriter = createDeferredCore();
  const writerStarted = createDeferredCore();
  const heldWriter = runOpenClawAgentWriteAdmission({ agentId, path: storePath }, async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
  });
  await writerStarted.promise;
  const work = new AsyncWorkScope();
  const errors: unknown[] = [];
  try {
    work.run(() =>
      recordSessionParticipantBestEffort({
        ...scope,
        identity: { type: "profile", id: "human-requester" },
        promptedAt: 1,
        onError: (error) => errors.push(error),
      }),
    );
    // The real recorder defers its write to the next microtask. Keep that original order.
    await Promise.resolve();
    expect(loadSessionEntryReadOnly(scope)?.participants ?? []).toEqual([]);
    const creation = spawnSubagentDirect(
      { task: "inherit accepted credit", context: "isolated" },
      { agentSessionKey: sessionKey, gitContributorProfileId: "human-requester" },
    );
    releaseWriter.resolve();
    await heldWriter;
    const result = await creation;
    expect(result).toMatchObject({ status: "accepted" });
    expect(inspectChild).toHaveBeenCalledOnce();
    await work.drain();

    expect(errors).toEqual([]);
    expect(loadSessionEntryReadOnly(scope)?.participants).toEqual([
      { identity: { type: "profile", id: "human-requester" } },
    ]);
  } finally {
    releaseWriter.resolve();
    await heldWriter;
    await work.drain();
  }
});

it.each(["requester-c", undefined])(
  "scopes a shared-main native child's credit to the admitted request (%s)",
  async (gitContributorProfileId) => {
    const sessionKey = fixture.parentSessionKey;
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "parent-id",
        updatedAt: 1,
        inheritedGitContributorProfileIds: ["unrelated-a", "unrelated-b"],
      },
    );
    const inspected = inspectChildCredit(gitContributorProfileId ? ["requester-c"] : undefined);
    useInProcessSpawns(inspected);
    const result = await spawnSubagentDirect(
      { task: "isolated Discord task", context: "isolated" },
      {
        agentSessionKey: sessionKey,
        agentChannel: "discord",
        agentTo: "channel:synthetic-thread",
        gitContributorProfileId,
      },
    );
    expect(result).toMatchObject({ status: "accepted" });
    expect(inspected).toHaveBeenCalledOnce();
  },
);

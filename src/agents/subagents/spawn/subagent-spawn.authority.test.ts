import "./subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { installSpawnAuthorityFixture, waitForSubagentCleanupCompleted, observeSubagentRun } from "./subagent-spawn.authority.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
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
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../../admitted-run-context.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { killSubagentRunAdmin } from "../registry/subagent-control.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import { registerSubagentRun } from "../registry/subagent-registry.js";
import {
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "../registry/subagent-run-generation.js";
import { resolveSubagentSessionStatus } from "../registry/subagent-session-metrics.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
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

function installDispatch(dispatch: (runId: unknown) => void, rollback?: () => Promise<void>) {
  spawnTesting.setDepsForTest({
    resolveContextEngine: async () =>
      Object.assign(
        new LegacyContextEngine(),
        rollback ? { prepareSubagentSpawn: async () => ({ rollback }) } : {},
      ),
    dispatchGatewayMethodInProcess: async <T>(method: string, params: Record<string, unknown>) => {
      expect(method).toBe("agent");
      dispatch(params.idempotencyKey);
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
        assertAllowed: () => {},
      });
      const interrupted = createDeferred();
      lease = consumeSessionEffectHandoff({
        scope: storePath,
        identities,
        handoffId: work.createHandoff(),
        onInterrupt: () => interrupted.resolve(),
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

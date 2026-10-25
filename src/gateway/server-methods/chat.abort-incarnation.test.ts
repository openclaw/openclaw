/** Cancellation binds session incarnations and retains exact durable dispatch fences. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { isSameSubagentRunOwner } from "../../agents/subagents/registry/subagent-run-generation.js";
import { releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { isPathInside } from "../../infra/path-guards.js";
import * as sessionLifecycle from "../../sessions/session-controller.lifecycle.js";
import {
  observeSessionWorkAdmissionDrain,
  rpcSourceTesting,
} from "../../sessions/session-lifecycle-admission.test-support.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.test-support.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";

const fixture = useChatAbortRegistryFixture();
const parentKey = "agent:main:main";

afterEach(() => {
  clearAgentRunContext("active");
  clearAgentRunContext("ended");
});

function abortParent() {
  const context = createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  const parent = createActiveRun(parentKey, { agentId: "main", owner: { connId: "owner" } });
  rpcSourceTesting.set("parent", parent);
  return {
    context,
    parent,
    pending: invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey: parentKey, runId: "parent" },
      client: { connId: "owner", connect: { scopes: ["operator.read", "operator.write"] } },
    }),
  };
}

it.each([false, true].flatMap((reset) => [true, false].map((completed) => ({ reset, completed }))))(
  "exact parent cancellation fences late descendants across an idle ancestor reset=$reset completed=$completed",
  async ({ reset, completed }) => {
    const activeKey = "agent:main:subagent:active";
    const endedKey = "agent:main:subagent:ended";
    const grandchildKey = "agent:main:subagent:grandchild";
    let storePath = "";
    for (const [runId, childSessionKey] of [
      ["active", activeKey],
      ["ended", endedKey],
    ] as const) {
      storePath = await fixture.seedRun({
        runId,
        childSessionKey,
        lifecycleRevision: "original",
      });
      // Real ownership prevents the registry sweeper from mistaking setup for lost work.
      registerAgentRunContext(runId, {
        sessionKey: childSessionKey,
        sessionId: `${runId}-session`,
      });
    }
    const ended = subagentRuns.get("ended")!;
    if (completed) {
      emitAgentEvent({
        runId: "ended",
        sessionKey: endedKey,
        stream: "lifecycle",
        data: { phase: "end", endedAt: Date.now() },
      });
      await fixture.settle();
      expect(subagentRuns.get("ended")?.execution.status).toBe("terminal");
      clearAgentRunContext("ended");
      await fixture.settle();
      expect(subagentRuns.get("ended")?.endedReason).toBe("subagent-complete");
    }
    expect(isSameSubagentRunOwner(subagentRuns.get("ended"), ended)).toBe(true);
    const entered = createDeferred();
    const resume = createDeferred();
    const endedMutationEntered = createDeferred();
    const resumeEndedMutation = createDeferred();
    const admission = await sessionLifecycle.beginSessionEffect({
      scope: storePath,
      identities: [activeKey, "active-session"],
      run: {
        runId: "active",
        sessionKey: activeKey,
        sessionId: "active-session",
        agentId: "main",
      },
      assertAllowed: () => {},
      onInterrupt: () => admission.release(),
    });
    const mutateSession = sessionLifecycle.runSessionMutation;
    let holdEndedMutation = !completed;
    const mutation = vi
      .spyOn(sessionLifecycle, "runSessionMutation")
      .mockImplementation(async (params) => {
        if (
          holdEndedMutation &&
          "scope" in params &&
          params.scope === storePath &&
          Array.from(params.identities).includes(endedKey)
        ) {
          holdEndedMutation = false;
          // Pause at mutation entry; completed ancestors use ungated late discovery.
          endedMutationEntered.resolve();
          await resumeEndedMutation.promise;
        }
        return await mutateSession(params);
      });
    const restoreDrain = observeSessionWorkAdmissionDrain(async (params, released) => {
      if (
        ("target" in params ? params.target.storeScope : params.scope) === storePath &&
        Array.from("target" in params ? params.target.aliases : params.identities).includes(
          activeKey,
        )
      ) {
        expect(released).toBe(true);
        // Hold after the real drain so sibling reset cannot consume its deadline.
        entered.resolve();
        await resume.promise;
      }
    });
    const abort = abortParent();
    const dispatch = vi.fn(async () => {});
    const interrupted = vi.fn();
    let newAdmission: Awaited<ReturnType<typeof sessionLifecycle.beginSessionEffect>> | undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        abort.pending,
        "abort missed admission drain",
      );
      expect(abort.parent.input.abortSignal.aborted).toBe(true);
      expect(sessionLifecycle.isSessionControllerWorkActive(storePath, [activeKey])).toBe(false);
      if (!completed) {
        await endedMutationEntered.promise;
      }
      if (reset) {
        const respond = vi.fn();
        await sessionMutationHandlers["sessions.reset"]!({
          params: { key: endedKey },
          context: abort.context as never,
          respond,
          client: { connect: { scopes: ["operator.admin"] } } as never,
          req: { type: "req", id: "reset", method: "sessions.reset" } as never,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ ok: true }),
          undefined,
        );
      }
      const session = loadExactSessionEntryReadOnly({ storePath, sessionKey: endedKey })?.entry;
      expect(session?.sessionId).toBe("ended-session");
      expect(session?.lifecycleRevision === "original").toBe(!reset);
      expect(isSameSubagentRunOwner(subagentRuns.get("ended"), ended)).toBe(true);
      if (!completed) {
        newAdmission = await sessionLifecycle.beginSessionEffect({
          scope: storePath,
          identities: [endedKey, "ended-session"],
          assertAllowed: () => {},
          onInterrupt: () => {
            interrupted();
            newAdmission?.release();
          },
        });
      }
      await fixture.seedRun({
        runId: "grandchild",
        childSessionKey: grandchildKey,
        requesterSessionKey: endedKey,
        requesterTurnRunId: "new-turn",
        queued: true,
      });
      fixture.queueRun({
        groupId: "late",
        runId: "grandchild",
        activeRunIds: ["capacity"],
        start: dispatch,
      });
      resume.resolve();
      resumeEndedMutation.resolve();
      const respond = await abort.pending;
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ aborted: true }));
      expect(subagentRuns.get("active")?.endedReason).toBe("subagent-killed");
      expect(subagentRuns.get("grandchild")?.execution.status).toBe(reset ? "queued" : "terminal");
      if (!completed) {
        expect(interrupted).toHaveBeenCalledTimes(reset ? 0 : 1);
        expect(subagentRuns.get("ended")?.execution.status).toBe(reset ? "running" : "terminal");
      }
      releaseSwarmRun("capacity");
      if (reset) {
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      } else {
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
      }
    } finally {
      newAdmission?.release();
      resume.resolve();
      resumeEndedMutation.resolve();
      admission.release();
      try {
        await abort.pending;
      } finally {
        restoreDrain();
        mutation.mockRestore();
        releaseSwarmRun("capacity");
        releaseSwarmRun("grandchild");
      }
    }
  },
);

it.each(["child", "ancestor"])(
  "retained durable intent prevents queued dispatch when the %s identity owner closes",
  async (faultOwner) => {
    const childAgent = faultOwner === "ancestor" ? "worker" : "broken";
    const badKey = `agent:${childAgent}:subagent:bad`;
    const ancestorKey = "agent:broken:subagent:ancestor";
    if (faultOwner === "ancestor") {
      await fixture.seedRun({
        runId: "ancestor",
        childSessionKey: ancestorKey,
        childAgentId: "broken",
        queued: true,
        lifecycleRevision: "original-ancestor",
      });
    }
    const storePath = await fixture.seedRun({
      runId: "bad",
      childSessionKey: badKey,
      childAgentId: childAgent,
      requesterSessionKey: faultOwner === "ancestor" ? ancestorKey : parentKey,
      requesterDisplayKey: parentKey,
      requesterAgentId: faultOwner === "ancestor" ? "broken" : "main",
      queued: true,
      lifecycleRevision: "original-child",
    });
    const database = listOpenClawAgentDatabasesForTest().find(
      (item) => item.agentId === "broken" && isPathInside(fixture.stateDir, item.path),
    )!;
    expect(database).toBeDefined();
    let closed = false;
    let fault: unknown;
    const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
      if (closed || !subagentRuns.get("bad")?.killIntent) {
        return;
      }
      try {
        expect(loadSubagentRegistryFromSqlite().get("bad")?.killIntent).toBeDefined();
        // Closure revokes the prepared identity synchronously; worker teardown may still run.
        expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        closed = true;
      } catch (error) {
        fault = error;
      }
    });
    const badDispatch = vi.fn(async () => {});
    const survivorDispatch = vi.fn(async () => {});
    const capacity = "read-failure-capacity";
    // Keep reservations queued while Stop prepares its session snapshot.
    for (const [runId, start] of [
      ["bad", badDispatch],
      ["survivor", survivorDispatch],
    ] as const) {
      fixture.queueRun({ groupId: "read-failure", runId, activeRunIds: [capacity], start });
    }
    try {
      const { parent, pending } = abortParent();
      const respond = await pending;
      expect(fault).toBeUndefined();
      expect(closed).toBe(true);
      expect(parent.input.abortSignal.aborted).toBe(true);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("descendant cancellation was incomplete"),
        }),
      );
      if (faultOwner === "ancestor") {
        expect(
          loadExactSessionEntryReadOnly({ storePath, sessionKey: badKey })?.entry.sessionId,
        ).toBe("bad-session");
      }
      expect(loadSubagentRegistryFromSqlite().get("bad")?.killIntent).toMatchObject({
        reason: "killed",
      });
      expect(releaseSwarmRun(capacity)).toBe(true);
      await vi.waitFor(() => expect(survivorDispatch).toHaveBeenCalledOnce());
      expect(
        badDispatch,
        "retained durable intent must withdraw its exact never-started reservation",
      ).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      releaseSwarmRun(capacity);
      releaseSwarmRun("bad");
      releaseSwarmRun("survivor");
    }
  },
);

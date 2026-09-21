/** Typed Stop exercises the real chat.send pipeline and collector cancellation owners. */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunQueued,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  activateSwarmRun,
  enqueueSwarmRun,
  releaseSwarmRun,
  reserveSwarmRun,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntrySync,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { findTaskByRunId, getTaskById } from "../../tasks/task-registry.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

const fixture = useChatAbortRegistryFixture();

function createGuardedStopFixture() {
  const storePath = path.join(fixture.stateDir, "shared.sqlite");
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { research: {}, ops: {} },
      defaults: { workspace: fixture.stateDir, sessionStore: { agentId: "ops" } },
    },
    session: { store: storePath },
    browser: { enabled: false },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const seed = (sessionKey: string, agentId: string, sessionId: string) => {
    const scope = { agentId, storePath, sessionKey, sessionId };
    replaceSessionEntrySync(scope, {
      sessionId,
      lifecycleRevision: "original",
      updatedAt: Date.now(),
    });
    return scope;
  };
  const other = seed("agent:research:guarded-other", "research", "research-other");
  const parent = seed("agent:ops:guarded-parent", "ops", "ops-parent");
  const peer = seed("agent:ops:guarded-peer", "ops", "ops-peer");
  const context = createChatAbortContext({
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  const otherRun = createActiveRun(other.sessionKey, other);
  context.chatAbortControllers.set("other-owner", otherRun);
  const send = (sessionKey: string, extra: Record<string, unknown> = {}) =>
    invokeChatAbortHandler({
      handler: (options) =>
        handleChatSend({
          ...options,
          params: {
            sessionKey,
            agentId: "ops",
            message: "/stop",
            idempotencyKey: "guarded-stop",
            ...extra,
          },
        }),
      context,
      request: { sessionKey, agentId: "ops" },
      client: { connId: "owner", connect: { scopes: ["operator.admin"] } },
    });
  const child = (runId: string, requesterSessionKey = parent.sessionKey) => {
    const scope = seed(`agent:ops:subagent:${runId}`, "ops", `${runId}-session`);
    const groupId = `guarded-stop-${runId}`;
    expect(
      reserveSwarmRun({
        groupId,
        runId,
        maxConcurrent: 1,
        activeRunIds: [`${runId}-capacity`],
      }),
    ).toBe(true);
    registerSubagentRun({
      runId,
      childSessionKey: scope.sessionKey,
      requesterSessionKey,
      requesterAgentId: "ops",
      requesterDisplayKey: requesterSessionKey,
      requesterTurnRunId: "parent",
      task: runId,
      cleanup: "keep",
      collect: true,
      queued: true,
      expectsCompletionMessage: false,
    });
    const start = vi.fn(async () => {});
    activateSwarmRun({
      groupId,
      runId,
      start,
      onStartFailure: () => true,
    });
    return { ...scope, runId, start };
  };
  return { cfg, context, parent, peer, other, otherRun, seed, send, child };
}

function appendStopCanary(
  scope: Parameters<typeof appendTranscriptMessageSync>[0],
  eventId: string,
  content: string,
) {
  expect(
    appendTranscriptMessageSync(scope, {
      eventId,
      message: { role: "user", content },
      parentId: null,
    }).ok,
  ).toBe(true);
}

it.each([
  {
    name: "stale leaf",
    key: "agent:ops:guarded-parent",
    expectedLeafEntryId: "stale",
    accepted: false,
  },
  {
    name: "nonempty transcript",
    key: "agent:ops:guarded-parent",
    expectedLeafEntryId: null,
    accepted: false,
  },
  {
    name: "copied leaf from another session",
    key: "agent:ops:guarded-parent",
    expectedLeafEntryId: "current-leaf",
    sessionId: "previous-session",
    accepted: false,
  },
  {
    name: "matching leaf and session",
    key: "agent:ops:guarded-parent",
    expectedLeafEntryId: "current-leaf",
    sessionId: "ops-parent",
    accepted: true,
  },
  { name: "unguarded peer session", key: "agent:ops:guarded-peer", accepted: true },
  {
    name: "session id without leaf CAS",
    key: "agent:ops:guarded-parent",
    sessionId: "old",
    accepted: true,
  },
  {
    name: "steer compatibility",
    key: "agent:ops:guarded-parent",
    expectedLeafEntryId: "stale",
    sessionId: "old",
    queueMode: "steer",
    accepted: true,
  },
])(
  "typed Stop honors $name without touching the other owner",
  async ({ name, key, accepted, ...extra }) => {
    const test = createGuardedStopFixture();
    const selected = key === test.peer.sessionKey ? test.peer : test.parent;
    appendStopCanary(selected, "current-leaf", "selected conversation");
    await waitForSessionTranscriptProjection(selected);
    const before = await loadTranscriptEvents(selected);
    const active = createActiveRun(selected.sessionKey, selected);
    const queued = createActiveRun(selected.sessionKey, selected);
    test.context.chatAbortControllers.set("parent", active);
    test.context.chatQueuedTurns.set("queued", queued);
    const respond = await test.send(key, extra);

    if (accepted) {
      expect(respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: ["queued", "parent"],
      });
    } else {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
      );
    }
    expect(active.controller.signal.aborted, name).toBe(accepted);
    expect(queued.controller.signal.aborted, name).toBe(accepted);
    expect(test.context.chatQueuedTurns.has("queued")).toBe(!accepted);
    expect(test.otherRun.controller.signal.aborted).toBe(false);
    expect(loadSessionEntryReadOnly(test.other)?.sessionId).toBe(test.other.sessionId);
    expect(await loadTranscriptEvents(selected)).toEqual(before);
  },
);

it.each(["replacement", "branch"] as const)(
  "typed Stop fences descendants after a parent %s and settles only its captured output",
  async (change) => {
    const test = createGuardedStopFixture();
    const child = test.child("original-child");
    const parent = createActiveRun(test.parent.sessionKey, test.parent);
    test.context.chatAbortControllers.set("parent", parent);
    test.context.chatRunState.getOrCreate("parent").buffer = "captured parent partial";
    let successor: ReturnType<typeof createActiveRun> | undefined;
    let successorQueue: ReturnType<typeof createActiveRun> | undefined;
    let successorChild: ReturnType<typeof test.child> | undefined;
    let replacement = test.parent;
    let callbackError: unknown;
    const changed = createDeferred();
    parent.controller.signal.addEventListener("abort", () => {
      queueMicrotask(() => {
        try {
          if (change === "replacement") {
            replacement = { ...test.parent, sessionId: "successor-session" };
            replaceSessionEntrySync(replacement, {
              sessionId: replacement.sessionId,
              lifecycleRevision: "successor",
              updatedAt: Date.now(),
            });
          }
          appendStopCanary(replacement, "successor-leaf", "successor conversation");
          successor = createActiveRun(replacement.sessionKey, replacement);
          successorQueue = createActiveRun(replacement.sessionKey, replacement);
          test.context.chatAbortControllers.set("successor", successor);
          test.context.chatQueuedTurns.set("successor-queued", successorQueue);
          successorChild = test.child("successor-child");
        } catch (error) {
          callbackError = error;
        } finally {
          changed.resolve();
        }
      });
    });
    try {
      const respond = await test.send("agent:ops:guarded-parent", {
        expectedLeafEntryId: null,
        sessionId: test.parent.sessionId,
      });
      await changed.promise;
      expect(callbackError).toBeUndefined();
      expect(parent.controller.signal.aborted).toBe(true);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
      );
      expect(successor?.controller.signal.aborted).toBe(false);
      expect(successorQueue?.controller.signal.aborted).toBe(false);
      expect(test.otherRun.controller.signal.aborted).toBe(false);
      expect(test.context.chatAbortControllers.get("successor")).toBe(successor);
      expect(test.context.chatQueuedTurns.get("successor-queued")).toBe(successorQueue);
      const successorDescendant = expectDefined(successorChild, "successor descendant");
      for (const selected of [child, successorDescendant]) {
        expect(getSubagentRunByChildSessionKey(selected.sessionKey)?.execution.status).toBe(
          "queued",
        );
        expect(selected.start).not.toHaveBeenCalled();
      }
      const events = await loadTranscriptEvents(replacement);
      expect(events).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: "successor conversation" }),
        }),
      );
      if (change === "branch") {
        expect(events).toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({
              content: [{ type: "text", text: "captured parent partial" }],
              openclawAbort: expect.objectContaining({ origin: "stop-command", runId: "parent" }),
            }),
          }),
        );
      } else {
        expect(JSON.stringify(events)).not.toContain("captured parent partial");
      }
      for (const run of [child, successorDescendant]) {
        releaseSwarmRun(`${run.runId}-capacity`);
      }
      await vi.waitFor(() => {
        expect(child.start).toHaveBeenCalledOnce();
        expect(successorChild?.start).toHaveBeenCalledOnce();
      });
    } finally {
      for (const runId of ["original-child", "successor-child"]) {
        releaseSwarmRun(`${runId}-capacity`);
        releaseSwarmRun(runId);
      }
    }
  },
);

it.each(["during drain", "after abort"] as const)(
  "typed Stop settles only accepted child cancellation when its parent guard changes %s",
  async (change) => {
    const test = createGuardedStopFixture();
    const child = test.seed("agent:ops:subagent:authority-child", "ops", "authority-child-session");
    const runId = "authority-child";
    registerSubagentRun({
      runId,
      childSessionKey: child.sessionKey,
      requesterSessionKey: test.parent.sessionKey,
      requesterAgentId: "ops",
      requesterDisplayKey: test.parent.sessionKey,
      requesterTurnRunId: "parent",
      task: "remain active until cancellation is accepted",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    const task = expectDefined(findTaskByRunId(runId), "child task");
    const parent = createActiveRun(test.parent.sessionKey, test.parent);
    test.context.chatAbortControllers.set("parent", parent);
    const controller = new AbortController();
    const changeParent = () => appendStopCanary(test.parent, "later-leaf", "changed parent");
    const abort = vi.fn(() => {
      controller.abort();
      if (change === "after abort") {
        changeParent();
      }
    });
    const handle = createEmbeddedRunHandle({ runId, abort });
    setActiveEmbeddedRun(child.sessionId, handle, child.sessionKey);
    const interrupted = createDeferred();
    const onInterrupt = vi.fn(() => {
      interrupted.resolve();
      if (change === "after abort") {
        admission.release();
      }
    });
    const admission = await beginSessionWorkAdmission({
      scope: child.storePath,
      identities: [child.sessionKey, child.sessionId],
      assertAllowed: () => {},
      onInterrupt,
    });
    const pending = test.send("agent:ops:guarded-parent", {
      expectedLeafEntryId: null,
      sessionId: test.parent.sessionId,
    });
    try {
      await Promise.race([
        interrupted.promise,
        pending.then(() => {
          throw new Error("Stop did not reach the child's admission drain");
        }),
      ]);
      expect(parent.controller.signal.aborted).toBe(true);
      if (change === "during drain") {
        expect(
          getLatestLiveSubagentRunByChildSessionKey(child.sessionKey)?.killIntent,
        ).toBeDefined();
        changeParent();
        admission.release();
      }
      const respond = await pending;
      const accepted = change === "after abort";
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
      );
      expect(onInterrupt).toHaveBeenCalledOnce();
      expect(controller.signal.aborted).toBe(accepted);
      expect(abort).toHaveBeenCalledTimes(Number(accepted));
      expect(getTaskById(task.taskId)?.status).toBe(accepted ? "cancelled" : "running");
      const retained = expectDefined(loadSubagentRegistryFromSqlite().get(runId), "retained child");
      expect(retained.killIntent).toBeUndefined();
      expect(loadSessionEntryReadOnly(child)?.abortedLastRun === true).toBe(accepted);
      expect(test.otherRun.controller.signal.aborted).toBe(false);
    } finally {
      admission.release();
      try {
        await pending;
      } finally {
        clearActiveEmbeddedRun(child.sessionId, handle, child.sessionKey);
      }
    }
  },
);

it("typed Stop cannot acquire a replacement collector after projection readiness yields", async () => {
  const test = createGuardedStopFixture();
  const collector = test.child("collector");
  expect(isSubagentRunQueued(getLatestLiveSubagentRunByChildSessionKey(collector.sessionKey))).toBe(
    true,
  );
  const descendant = test.child("collector-descendant", collector.sessionKey);
  const old = createActiveRun(collector.sessionKey, collector);
  test.context.chatAbortControllers.set("old-collector", old);
  test.context.chatRunState.getOrCreate("old-collector").buffer = "old collector partial";
  const projection = await createSessionRowProjection({ cfg: test.cfg });
  await projection.ensureMaterialized();
  bindSessionRowProjection(test.context, () => projection);
  const entered = createDeferred();
  const resume = createDeferred();
  const materialize = projection.ensureMaterialized.bind(projection);
  const readiness = vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    await materialize();
  });
  const pending = test.send(collector.sessionKey, {
    expectedLeafEntryId: null,
    sessionId: collector.sessionId,
  });
  try {
    await Promise.race([
      entered.promise,
      pending.then((respond) => {
        throw new Error(
          `Stop did not reach collector projection readiness: ${JSON.stringify(respond.mock.calls)}`,
        );
      }),
    ]);
    const replacement = { ...collector, sessionId: "replacement-collector" };
    replaceSessionEntrySync(replacement, {
      sessionId: replacement.sessionId,
      lifecycleRevision: "successor",
      updatedAt: Date.now(),
    });
    appendStopCanary(replacement, "replacement-leaf", "replacement collector canary");
    const successor = createActiveRun(collector.sessionKey, replacement);
    const queued = createActiveRun(collector.sessionKey, replacement);
    test.context.chatAbortControllers.set("successor-collector", successor);
    test.context.chatQueuedTurns.set("successor-queued", queued);
    resume.resolve();
    const respond = await pending;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
    );
    for (const run of [old, successor, queued, test.otherRun]) {
      expect(run.controller.signal.aborted).toBe(false);
    }
    expect(test.context.chatQueuedTurns.get("successor-queued")).toBe(queued);
    for (const child of [collector, descendant]) {
      expect(getSubagentRunByChildSessionKey(child.sessionKey)?.execution.status).toBe("queued");
      expect(child.start).not.toHaveBeenCalled();
    }
    const events = await loadTranscriptEvents(replacement);
    expect(JSON.stringify(events)).toContain("replacement collector canary");
    expect(JSON.stringify(events)).not.toContain("old collector partial");
    releaseSwarmRun("collector-capacity");
    releaseSwarmRun("collector-descendant-capacity");
    await vi.waitFor(() => {
      expect(collector.start).toHaveBeenCalledOnce();
      expect(descendant.start).toHaveBeenCalledOnce();
    });
  } finally {
    resume.resolve();
    try {
      await pending;
    } finally {
      readiness.mockRestore();
      projection.dispose();
      for (const runId of ["collector", "collector-descendant"]) {
        releaseSwarmRun(`${runId}-capacity`);
        releaseSwarmRun(runId);
      }
    }
  }
});

it.each(
  ["agent:main:main", "main"].flatMap((requestSessionKey) =>
    ["owned", "orphan", "foreign", "protected", "ordinary"].map((kind) => ({
      requestSessionKey,
      kind,
    })),
  ),
)(
  "typed Stop respects full-session collector ownership: $kind via $requestSessionKey",
  async ({ kind, requestSessionKey }) => {
    const sessionKey = "agent:main:main";
    const runningKey = "agent:main:subagent:running";
    const queuedKey = "agent:main:subagent:queued";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: "parent-session",
    });
    for (const [runId, childSessionKey] of [
      ["running", runningKey],
      ["queued", queuedKey],
    ] as const) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: `${runId}-session`,
      });
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: sessionKey,
        requesterTurnRunId: "parent",
        task: runId,
        cleanup: "keep",
        collect: true,
        queued: runId === "queued",
        expectsCompletionMessage: false,
      });
    }
    const dispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "typed-stop",
      runId: "queued",
      maxConcurrent: 1,
      activeRunIds: ["capacity"],
      start: dispatch,
      onStartFailure: () => true,
    });
    const runningAbort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "running", abort: runningAbort });
    setActiveEmbeddedRun("running-session", handle, runningKey);
    const parent = createActiveRun(sessionKey, {
      sessionId: "parent-session",
      agentId: "main",
      owner: { connId: kind === "foreign" ? "foreign" : "owner" },
      controlUiVisible: kind === "protected" ? false : undefined,
    });
    parent.controller.signal.addEventListener("abort", () => releaseSwarmRun("capacity"));
    const context = createChatAbortContext({ getRuntimeConfig });
    if (kind !== "orphan") {
      context.chatAbortControllers.set("parent", parent);
      context.chatRunState.getOrCreate("parent").buffer = "partial parent reply";
    }
    const canCascade = kind === "owned" || kind === "orphan";
    try {
      const respond = await invokeChatAbortHandler({
        handler:
          kind === "ordinary"
            ? handleChatAbortRequestWithLifecycle
            : (options) =>
                handleChatSend({
                  ...options,
                  params: {
                    sessionKey: requestSessionKey,
                    message: "/stop",
                    idempotencyKey: "typed-stop",
                  },
                }),
        context,
        request: { sessionKey: requestSessionKey },
        client: { connId: "owner", connect: { scopes: ["operator.read", "operator.write"] } },
      });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(kind !== "foreign");
      expect(parent.controller.signal.aborted).toBe(kind === "owned" || kind === "ordinary");
      expect(runningAbort).toHaveBeenCalledTimes(canCascade ? 1 : 0);
      for (const key of [runningKey, queuedKey]) {
        expect(getSubagentRunByChildSessionKey(key)?.execution.status).toBe(
          canCascade ? "terminal" : key === runningKey ? "running" : "queued",
        );
      }
      releaseSwarmRun("capacity");
      if (canCascade) {
        expect(dispatch).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: kind === "owned" ? ["parent"] : [],
        });
      } else {
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      }
      const events = await loadTranscriptEvents({
        storePath,
        sessionKey,
        sessionId: "parent-session",
        agentId: "main",
      });
      if (kind === "owned") {
        expect(events).toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({
              content: [{ type: "text", text: "partial parent reply" }],
              openclawAbort: expect.objectContaining({
                aborted: true,
                origin: "stop-command",
                runId: "parent",
              }),
            }),
          }),
        );
      }
    } finally {
      clearActiveEmbeddedRun("running-session", handle, runningKey);
      releaseSwarmRun("capacity");
      releaseSwarmRun("queued");
    }
  },
);

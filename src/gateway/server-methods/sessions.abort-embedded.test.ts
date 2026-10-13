/** Exact recovered-parent Stop owns its descendants, not other turns or queues. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  clearEmbeddedAgentRunAbortabilityForRunId,
  isEmbeddedAgentRunAbortableForRunId,
  resolveActiveEmbeddedRunOwnerByRunId,
  retainEmbeddedAgentRunAbortabilityForRunId,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  enqueueSwarmRun,
  releaseSwarmRun,
  isSwarmRunActive,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import * as sessionEntryRead from "../../config/sessions/session-entry-read-runtime.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { cancelGatewayWorkerSessionWork } from "../server-worker-placement-cancel.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { createActiveRun, createChatAbortContext } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import {
  prepareSessionLifecycleDrain,
  type SessionLifecycleDrain,
} from "./sessions-lifecycle-drain.js";

const fixture = useChatAbortRegistryFixture();
const parentKey = "agent:main:direct:embedded-parent";
const parentId = "embedded-parent-session";
const childKey = (id: string) => `agent:main:subagent:${id}`;

async function seedEmbeddedSession(runId: string, profileId?: string) {
  const target = { agentId: "main", sessionKey: parentKey };
  await sessions.upsertSessionEntryCore(target, {
    sessionId: parentId,
    updatedAt: 1,
    createdActor: profileId ? { type: "human", source: "profile", id: profileId } : undefined,
  });
  await persistGatewaySessionLifecycleEvent({
    ...target,
    event: {
      runId,
      sessionId: parentId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      ts: 1_000,
      data: { phase: "start", startedAt: 1_000 },
    },
  });
  return target;
}

it.each(["chat.abort", "sessions.abort", "controller-backed"] as const)(
  "%s stops a live embedded turn and persists cancellation before responding",
  async (mode) => {
    const runId = "http-embedded-run";
    const target = await seedEmbeddedSession(runId);
    const context = createDirectChatContext({ getRuntimeConfig });
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId, abort });
    setActiveEmbeddedRun(parentId, handle, parentKey, undefined, "main");
    const registration =
      mode === "controller-backed"
        ? registerChatAbortController({
            chatAbortControllers: context.chatAbortControllers,
            runId,
            sessionId: parentId,
            sessionKey: parentKey,
            agentId: "main",
            timeoutMs: 30_000,
          })
        : undefined;
    registration?.markExecutionStarted();
    registration?.controller.signal.addEventListener("abort", abort, { once: true });
    let responseEntry: ReturnType<typeof sessions.loadSessionEntry>;
    const respond = vi.fn(() => {
      responseEntry = sessions.loadSessionEntry(target);
    });
    const method = mode === "sessions.abort" ? mode : "chat.abort";
    try {
      await withExecRequestTurn(
        { identity: { runId, sessionId: parentId, sessionKey: parentKey, agentId: "main" } },
        async () => {
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "http-stop",
              method,
              params: method === "chat.abort" ? { sessionKey: parentKey } : { key: parentKey },
            },
            client: roleClient("write", "http-stop-operator"),
            context,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: {
              "chat.abort": handleChatAbortRequest,
              "sessions.abort": sessionAbortHandlers["sessions.abort"]!,
            },
          });
        },
      );
      expect(abort).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        method === "chat.abort"
          ? { ok: true, aborted: true, runIds: [runId] }
          : { ok: true, abortedRunId: runId, status: "aborted" },
      ]);
      if (!registration) {
        expect(responseEntry).toMatchObject({
          status: "killed",
          abortedLastRun: true,
          lastRunId: runId,
        });
        expect(responseEntry?.lifecycleRunId).toBeUndefined();
        expect(context.dedupe.has(`chat:${runId}`)).toBe(false);
        expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
      }
    } finally {
      registration?.cleanup();
      clearActiveEmbeddedRun(parentId, handle, parentKey);
    }
  },
);

it.each(["revoked", "current"] as const)(
  "archive drain fences embedded cancellation persistence (authority %s)",
  async (authority) => {
    const runId = "drain-embedded-run";
    const target = await seedEmbeddedSession(runId);
    const before = sessions.loadSessionEntry(target);
    expect(before).toMatchObject({ lifecycleRunId: runId, abortedLastRun: false });
    let current = true;
    const revoked = new Error("archive drain authority revoked");
    const abort = vi.fn(() => {
      current = authority === "current";
      clearActiveEmbeddedRun(parentId, handle, parentKey);
    });
    const handle = createEmbeddedRunHandle({ runId, abort });
    setActiveEmbeddedRun(parentId, handle, parentKey, undefined, "main");
    let drain: SessionLifecycleDrain | undefined;
    try {
      let failure: unknown;
      try {
        drain = await prepareSessionLifecycleDrain({
          action: "archive",
          authorize: () => {
            if (!current) {
              throw revoked;
            }
          },
          context: createDirectChatContext({ getRuntimeConfig }),
          storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
            agentId: "main",
          }),
          sessionKeys: [parentKey],
          sessionKey: parentKey,
          sessionId: parentId,
          agentId: "main",
          defaultAgentId: "main",
          lifecycleIdentities: [parentKey, parentId],
        });
      } catch (error) {
        failure = error;
      }
      expect(abort).toHaveBeenCalledOnce();
      const after = sessions.loadSessionEntry({ ...target, readConsistency: "latest" });
      if (authority === "revoked") {
        expect(after).toEqual(before);
        expect(drain).toBeUndefined();
        expect(failure).toMatchObject({
          message: "Chat cancellation and persistence failed",
          errors: [revoked, revoked],
        });
      } else {
        expect(failure).toBeUndefined();
        expect(drain?.hasAuthoritativeWork()).toBe(false);
        expect(after).toMatchObject({ status: "killed", abortedLastRun: true, lastRunId: runId });
        expect(after?.lifecycleRunId).toBeUndefined();
      }
    } finally {
      drain?.release();
      clearActiveEmbeddedRun(parentId, handle, parentKey);
    }
  },
);

it("worker placement cancellation preserves controller-less embedded work", async () => {
  const runId = "placement-embedded-run";
  const target = await seedEmbeddedSession(runId);
  const before = sessions.loadSessionEntry(target);
  const abort = vi.fn();
  const handle = createEmbeddedRunHandle({ runId, abort });
  setActiveEmbeddedRun(parentId, handle, parentKey, undefined, "main");
  try {
    await cancelGatewayWorkerSessionWork(createDirectChatContext({ getRuntimeConfig }), {
      sessionId: parentId,
      sessionKeys: [parentKey],
      agentId: "main",
      assertCurrent: () => {},
    });
    expect(abort).not.toHaveBeenCalled();
    expect(sessions.loadSessionEntry({ ...target, readConsistency: "latest" })).toEqual(before);
  } finally {
    clearActiveEmbeddedRun(parentId, handle, parentKey);
  }
});

it.each(["forbidden", "allowed"] as const)(
  "chat.abort enforces session access before embedded Stop effects (%s)",
  async (access) => {
    const owner = roleClient("none", "embedded-session-owner");
    const client = access === "allowed" ? owner : roleClient("none", "embedded-session-outsider");
    client.connect.scopes = ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    const runId = "shared-embedded-run";
    const target = await seedEmbeddedSession(runId, owner.authenticatedUserProfile!.profileId);
    const before = sessions.loadSessionEntry(target);
    expect(before).toMatchObject({ lifecycleRunId: runId, abortedLastRun: false });
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId, abort });
    setActiveEmbeddedRun(parentId, handle, parentKey, undefined, "main");
    const respond = vi.fn();
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "shared-embedded-stop",
          method: "chat.abort",
          params: { sessionKey: parentKey },
        },
        client,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        respond,
        isWebchatConnect: () => false,
        extraHandlers: { "chat.abort": handleChatAbortRequest },
      });
      expect(respond).toHaveBeenCalledOnce();
      const after = sessions.loadSessionEntry({ ...target, readConsistency: "latest" });
      if (access === "forbidden") {
        expect(abort).not.toHaveBeenCalled();
        expect(after).toEqual(before);
        expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            message: `Session "${parentKey}" was not found.`,
          }),
        ]);
      } else {
        expect(abort).toHaveBeenCalledOnce();
        expect(after).toMatchObject({ status: "killed", abortedLastRun: true, lastRunId: runId });
        expect(after?.lifecycleRunId).toBeUndefined();
        expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
          true,
          { ok: true, aborted: true, runIds: [runId] },
        ]);
      }
    } finally {
      clearActiveEmbeddedRun(parentId, handle, parentKey);
    }
  },
);

it.each(["before signal", "after signal"] as const)(
  "chat.abort fences embedded Stop effects when authority is revoked %s",
  async (timing) => {
    const client = roleClient("none", "revoked-embedded-owner");
    client.connId = "revoked-embedded-connection";
    client.connect.scopes = ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    const runId = "revoked-embedded-run";
    const target = await seedEmbeddedSession(runId, client.authenticatedUserProfile!.profileId);
    const before = sessions.loadSessionEntry(target);
    expect(before).toMatchObject({ lifecycleRunId: runId, abortedLastRun: false });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const queued = createActiveRun(parentKey, {
      sessionId: parentId,
      agentId: "main",
      owner: { connId: client.connId },
    });
    context.chatQueuedTurns.set("authorized-queued", queued);
    let current = true;
    if (timing === "before signal") {
      queued.controller.signal.addEventListener(
        "abort",
        () => {
          current = false;
        },
        { once: true },
      );
    }
    const abort = vi.fn(() => {
      if (timing === "after signal") {
        current = false;
      }
    });
    const handle = createEmbeddedRunHandle({ runId, abort });
    setActiveEmbeddedRun(parentId, handle, parentKey, undefined, "main");
    const respond = vi.fn();
    const revoked = new Error("embedded Stop authority revoked");
    try {
      const outcome = await Promise.allSettled([
        handleGatewayRequest({
          req: {
            type: "req",
            id: "revoked-embedded-stop",
            method: "chat.abort",
            params: { sessionKey: parentKey },
          },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          sessionMutationCommitGuard: () => {
            if (!current) {
              throw revoked;
            }
          },
          extraHandlers: { "chat.abort": handleChatAbortRequest },
        }),
      ]);
      expect(queued.controller.signal.aborted).toBe(true);
      expect(abort).toHaveBeenCalledTimes(timing === "after signal" ? 1 : 0);
      expect(sessions.loadSessionEntry({ ...target, readConsistency: "latest" })).toEqual(before);
      expect(respond).not.toHaveBeenCalled();
      expect(outcome).toEqual([
        {
          status: "rejected",
          reason:
            timing === "before signal"
              ? revoked
              : expect.objectContaining({
                  message: "Chat cancellation and persistence failed",
                  errors: [revoked, revoked],
                }),
        },
      ]);
    } finally {
      clearActiveEmbeddedRun(parentId, handle, parentKey);
    }
  },
);

it.each(["matched", "old-incarnation", "foreign-key"] as const)(
  "narrow chat.abort only stops the admitted embedded producer (%s)",
  async (target) => {
    const client = roleClient("view", "session-chat-stop-owner");
    client.connect.scopes = ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    await sessions.upsertSessionEntryCore(
      { agentId: "main", sessionKey: parentKey },
      {
        sessionId: parentId,
        updatedAt: 1,
        createdActor: {
          type: "human",
          source: "profile",
          id: client.authenticatedUserProfile!.profileId,
        },
      },
    );
    const selectedId = target === "old-incarnation" ? "previous-parent" : parentId;
    const selectedKey = target === "foreign-key" ? "agent:main:foreign" : parentKey;
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "narrow-embedded", abort });
    setActiveEmbeddedRun(selectedId, handle, selectedKey);
    const respond = vi.fn();
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "narrow-chat-stop",
          method: "chat.abort",
          params: { sessionKey: parentKey },
        },
        client,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        respond,
        isWebchatConnect: () => false,
        extraHandlers: { "chat.abort": handleChatAbortRequest },
      });
      expect(abort).toHaveBeenCalledTimes(target === "matched" ? 1 : 0);
      expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        {
          ok: true,
          aborted: target === "matched",
          runIds: target === "matched" ? ["narrow-embedded"] : [],
        },
      ]);
    } finally {
      clearActiveEmbeddedRun(selectedId, handle, selectedKey);
    }
  },
);

it.each(["matched", "old-incarnation", "foreign-key", "missing-row"] as const)(
  "narrow sessions.abort qualifies the exact %s embedded producer before effects",
  async (target) => {
    const client = roleClient("view", "embedded-stop-owner");
    client.connect.scopes = ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    if (target !== "missing-row") {
      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: parentKey },
        {
          sessionId: parentId,
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        },
      );
    }
    const selectedId = target === "old-incarnation" ? "previous-parent" : parentId;
    const selectedKey = target === "foreign-key" ? "agent:main:foreign" : parentKey;
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "selected-embedded", abort });
    setActiveEmbeddedRun(selectedId, handle, selectedKey);
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const respond = vi.fn();
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "embedded-stop",
          method: "sessions.abort",
          params: { key: parentKey, runId: "selected-embedded" },
        },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
      });
      expect(abort).toHaveBeenCalledTimes(target === "matched" ? 1 : 0);
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(target === "matched");
      if (target === "matched") {
        expect(respond.mock.calls[0]?.[1]).toEqual({
          ok: true,
          abortedRunId: "selected-embedded",
          status: "aborted",
        });
      } else {
        expect(context.dedupe.size).toBe(0);
        expect(context.chatQueuedTurns.size).toBe(0);
        expect(context.chatAbortControllers.size).toBe(0);
      }
    } finally {
      clearActiveEmbeddedRun(selectedId, handle, selectedKey);
    }
  },
);

it.each([false, true])(
  "session-wide Stop retains its captured embedded owner (broad=%s)",
  async (broad) => {
    const client = roleClient("write", "late-embedded-stop-owner");
    client.connId = "late-embedded-stop";
    client.connect.scopes = broad
      ? ["operator.write", "operator.sessions.write"]
      : ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    await sessions.upsertSessionEntryCore(
      { agentId: "main", sessionKey: parentKey },
      {
        sessionId: parentId,
        updatedAt: 1,
        createdActor: {
          type: "human",
          source: "profile",
          id: client.authenticatedUserProfile!.profileId,
        },
      },
    );
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const queued = createActiveRun(parentKey, {
      sessionId: parentId,
      agentId: "main",
      owner: { connId: client.connId },
    });
    context.chatQueuedTurns.set("original-queued", queued);
    const abort = vi.fn();
    const successor = createEmbeddedRunHandle({ runId: "late-successor", abort });
    queued.controller.signal.addEventListener(
      "abort",
      () => setActiveEmbeddedRun(parentId, successor, parentKey),
      { once: true },
    );
    const respond = vi.fn();
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "late-embedded",
          method: "sessions.abort",
          params: { key: parentKey },
        },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
      });
      expect(queued.controller.signal.aborted).toBe(true);
      expect(abort).toHaveBeenCalledTimes(broad ? 1 : 0);
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[1]).toEqual({
        ok: true,
        abortedRunId: "original-queued",
        status: "aborted",
      });
    } finally {
      clearActiveEmbeddedRun(parentId, successor, parentKey);
    }
  },
);

async function stopParent(runId = "parent") {
  const context = createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  expect(context.chatAbortControllers.size).toBe(0);
  const respond = vi.fn();
  await sessionAbortHandlers["sessions.abort"]!({
    req: { type: "req", id: "stop", method: "sessions.abort" },
    params: { key: parentKey, runId },
    respond,
    context: context as never,
    client: {
      connId: "operator",
      connect: { scopes: ["operator.read", "operator.write"] },
    } as never,
    isWebchatConnect: () => false,
  });
  return respond;
}

async function seedChild(id: string, turn: string, queued = true, requester = parentKey) {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childKey(id),
    defaultSessionId: id,
  });
  await registerSubagentRun({
    runId: id,
    childSessionKey: childKey(id),
    requesterSessionKey: requester,
    requesterAgentId: "main",
    requesterDisplayKey: requester,
    requesterTurnRunId: turn,
    task: id,
    collect: true,
    queued,
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
}

it("exact embedded Stop cancels running and queued collectors without dispatching the queued sibling", async () => {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: parentKey,
    defaultSessionId: parentId,
  });
  await seedChild("running", "parent", false);
  await seedChild("queued", "parent");
  await seedChild("other-turn", "other-parent");
  await seedChild("other-session", "parent", true, "agent:main:direct:other");
  const queuedDispatch = vi.fn(async () => {});
  const otherTurnDispatch = vi.fn(async () => {});
  const otherSessionDispatch = vi.fn(async () => {});
  for (const [runId, start] of [
    ["queued", queuedDispatch],
    ["other-turn", otherTurnDispatch],
  ] as const) {
    enqueueSwarmRun({
      groupId: "selected",
      runId,
      start,
      activeRunIds: ["running"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
  }
  enqueueSwarmRun({
    groupId: "unrelated",
    runId: "other-session",
    start: otherSessionDispatch,
    activeRunIds: ["unrelated-capacity"],
    maxConcurrent: 1,
    onStartFailure: () => true,
  });
  const parentAbort = vi.fn(() => {
    emitAgentEvent({
      runId: "parent",
      sessionKey: parentKey,
      sessionId: parentId,
      stream: "lifecycle",
      data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
    });
  });
  const childAbort = vi.fn(() => {
    // The real lifecycle listener/cleanup releases the active collector slot.
    emitAgentEvent({
      runId: "running",
      sessionKey: childKey("running"),
      sessionId: "running",
      stream: "lifecycle",
      data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
    });
  });
  const parent = createEmbeddedRunHandle({ runId: "parent", abort: parentAbort });
  const child = createEmbeddedRunHandle({ runId: "running", abort: childAbort });
  setActiveEmbeddedRun(parentId, parent, parentKey);
  setActiveEmbeddedRun("running", child, childKey("running"));
  try {
    const respond = await stopParent();
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      abortedRunId: "parent",
      status: "aborted",
    });
    expect(parentAbort).toHaveBeenCalledOnce();
    await fixture.settle();
    for (const id of ["running", "queued"]) {
      expect(await getSubagentRunByChildSessionKey(childKey(id)), id).toMatchObject({
        endedReason: "subagent-killed",
      });
    }
    expect(childAbort).toHaveBeenCalledOnce();
    expect(queuedDispatch).not.toHaveBeenCalled();
    expect(isSwarmRunActive("running")).toBe(false);
    await vi.waitFor(() => expect(otherTurnDispatch).toHaveBeenCalledOnce());
    for (const id of ["other-turn", "other-session"]) {
      expect((await getSubagentRunByChildSessionKey(childKey(id)))?.endedReason).toBeUndefined();
    }
    expect(otherSessionDispatch).not.toHaveBeenCalled();
    expect(releaseSwarmRun("unrelated-capacity")).toBe(true);
    await vi.waitFor(() => expect(otherSessionDispatch).toHaveBeenCalledOnce());
  } finally {
    clearActiveEmbeddedRun(parentId, parent, parentKey);
    clearActiveEmbeddedRun("running", child, childKey("running"));
  }
});

it.each(["replaced", "throwing", "unreadable child"])(
  "%s embedded Stop leaves descendants eligible",
  async (state) => {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: parentKey,
      defaultSessionId: parentId,
    });
    await seedChild("queued", "parent");
    const dispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "declined",
      runId: "queued",
      start: dispatch,
      activeRunIds: ["capacity"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
    const abort = vi.fn(() => {
      throw new Error("parent refused Stop");
    });
    const parent = createEmbeddedRunHandle({
      runId: "parent",
      abort,
      isAbortable: state !== "unreadable child",
    });
    const replacementAbort = vi.fn();
    const replacement = createEmbeddedRunHandle({ runId: "replacement", abort: replacementAbort });
    setActiveEmbeddedRun(parentId, parent, parentKey);
    if (state === "replaced") {
      setActiveEmbeddedRun(parentId, replacement, parentKey);
    }
    const exactRead = sessionEntryRead.withSessionEntryReadOnlyInWorker;
    const failedRead = vi.fn();
    const reader = vi
      .spyOn(sessionEntryRead, "withSessionEntryReadOnlyInWorker")
      .mockImplementation((scope, assertCurrent, consume) => {
        if (state === "unreadable child" && scope.sessionKey === childKey("queued")) {
          failedRead();
          return Promise.reject(new Error("preparatory child read failed"));
        }
        return exactRead(scope, assertCurrent, consume);
      });
    try {
      const respond = await stopParent();
      if (state === "unreadable child") {
        expect(failedRead).toHaveBeenCalled();
      }
      expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        { ok: true, abortedRunId: null, status: "no-active-run" },
      ]);
      expect(abort).toHaveBeenCalledTimes(state === "throwing" ? 1 : 0);
      expect(replacementAbort).not.toHaveBeenCalled();
      expect(await getSubagentRunByChildSessionKey(childKey("queued"))).toMatchObject({
        execution: { status: "queued" },
      });
      expect(
        (await getSubagentRunByChildSessionKey(childKey("queued")))?.killIntent,
      ).toBeUndefined();
      expect(dispatch).not.toHaveBeenCalled();
      expect(releaseSwarmRun("capacity")).toBe(true);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    } finally {
      reader.mockRestore();
      clearActiveEmbeddedRun(parentId, state === "replaced" ? replacement : parent, parentKey);
    }
  },
);

it.each([true, false])(
  "sessions.abort controller-backed Stop respects parent acceptance (finalizing=%s)",
  async (finalizing) => {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: parentKey,
      defaultSessionId: parentId,
    });
    await seedChild("running", "parent", false);
    await seedChild("queued", "parent");
    const dispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "controller-backed",
      runId: "queued",
      start: dispatch,
      activeRunIds: ["running"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
    const context = createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
    });
    // Match native admission's retained abortability binding, including its
    // controller-removal cleanup; an absent native handle alone permits abort.
    expect(isEmbeddedAgentRunAbortableForRunId("parent")).toBe(true);
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: "parent",
      sessionId: parentId,
      sessionKey: parentKey,
      agentId: "main",
      ownerConnId: "operator",
      kind: "agent",
      timeoutMs: 30_000,
      isAbortable: () => isEmbeddedAgentRunAbortableForRunId("parent"),
      onRemoved: () => clearEmbeddedAgentRunAbortabilityForRunId("parent"),
    });
    expect(registration.registered).toBe(true);
    retainEmbeddedAgentRunAbortabilityForRunId("parent");
    const parentAbort = vi.fn();
    const parentState = { runId: "parent", abort: parentAbort, isAbortable: true };
    const parent = createEmbeddedRunHandle(parentState);
    const childAbort = vi.fn(() => {
      emitAgentEvent({
        runId: "running",
        sessionKey: childKey("running"),
        sessionId: "running",
        stream: "lifecycle",
        data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
      });
    });
    const child = createEmbeddedRunHandle({ runId: "running", abort: childAbort });
    registration.controller.signal.addEventListener("abort", parentAbort);
    setActiveEmbeddedRun(parentId, parent, parentKey);
    setActiveEmbeddedRun("running", child, childKey("running"));
    expect(registration.markExecutionStarted()).toBe(true);
    try {
      if (finalizing) {
        parentState.isAbortable = false;
        clearActiveEmbeddedRun(parentId, parent, parentKey);
        expect(resolveActiveEmbeddedRunOwnerByRunId("parent")).toBeUndefined();
      } else {
        expect(resolveActiveEmbeddedRunOwnerByRunId("parent")).toBeDefined();
      }
      expect(isEmbeddedAgentRunAbortableForRunId("parent")).toBe(!finalizing);
      expect(context.chatAbortControllers.get("parent")).toBe(registration.entry);
      const respond = vi.fn();
      await sessionAbortHandlers["sessions.abort"]!({
        req: { type: "req", id: "stop", method: "sessions.abort" },
        params: { key: parentKey, runId: "parent" },
        respond,
        context: context as never,
        client: {
          connId: "operator",
          connect: { scopes: ["operator.read", "operator.write"] },
        } as never,
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        {
          ok: true,
          abortedRunId: finalizing ? null : "parent",
          status: finalizing ? "no-active-run" : "aborted",
        },
      ]);
      expect(registration.controller.signal.aborted).toBe(!finalizing);
      expect(parentAbort).toHaveBeenCalledTimes(finalizing ? 0 : 1);
      await fixture.settle();
      expect.soft(childAbort).toHaveBeenCalledTimes(finalizing ? 0 : 1);
      expect(dispatch).not.toHaveBeenCalled();
      for (const id of ["running", "queued"]) {
        const run = await getSubagentRunByChildSessionKey(childKey(id));
        if (finalizing) {
          expect.soft(run?.endedReason, id).toBeUndefined();
          expect.soft(run?.killIntent, id).toBeUndefined();
        } else {
          expect(run, id).toMatchObject({ endedReason: "subagent-killed" });
        }
      }
      if (finalizing) {
        expect.soft(await getSubagentRunByChildSessionKey(childKey("queued"))).toMatchObject({
          execution: { status: "queued" },
        });
        releaseSwarmRun("running");
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      } else {
        expect(isSwarmRunActive("running")).toBe(false);
      }
    } finally {
      registration.controller.signal.removeEventListener("abort", parentAbort);
      clearActiveEmbeddedRun(parentId, parent, parentKey);
      clearActiveEmbeddedRun("running", child, childKey("running"));
      registration.cleanup();
      expect(isEmbeddedAgentRunAbortableForRunId("parent")).toBe(true);
    }
  },
);

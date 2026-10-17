/** Exact recovered-parent Stop owns its descendants, not other turns or queues. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
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
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import {
  isReplyRunAbortableForSignal,
  retainReplyOperationUntilComplete,
} from "../../auto-reply/reply/reply-run-registry.state.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import * as sessionEntryRead from "../../config/sessions/session-entry-read-runtime.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
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
const childRun = (id: string) => getSubagentRunByChildSessionKey(childKey(id));
const parentIdentity = { sessionId: parentId, sessionKey: parentKey, agentId: "main" };
const sessionResult = (abortedRunId: string | null) => ({
  ok: true,
  abortedRunId,
  status: abortedRunId ? "aborted" : "no-active-run",
});
const chatResult = (runId: string | null) => ({
  ok: true,
  aborted: runId !== null,
  runIds: runId === null ? [] : [runId],
});
function expectReply(respond: ReturnType<typeof vi.fn>, result: unknown) {
  expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([true, result]);
}
function expectKilled(entry: ReturnType<typeof sessions.loadSessionEntry>, runId: string) {
  expect(entry).toMatchObject({ status: "killed", abortedLastRun: true, lastRunId: runId });
  expect(entry?.lifecycleRunId).toBeUndefined();
}

function activeRun(
  runId: string,
  abort = vi.fn(),
  sessionId = parentId,
  sessionKey = parentKey,
  agentId?: string,
) {
  const handle = createEmbeddedRunHandle({ runId, abort });
  setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, agentId);
  return {
    abort,
    handle,
    [Symbol.dispose]: () => clearActiveEmbeddedRun(sessionId, handle, sessionKey),
  };
}

function registerParent(
  context: Pick<Parameters<typeof registerChatAbortController>[0], "chatAbortControllers">,
  runId: string,
  options: Partial<Parameters<typeof registerChatAbortController>[0]> = {},
) {
  return registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId,
    ...parentIdentity,
    timeoutMs: 30_000,
    ...options,
  });
}

function drainParent(
  action: "archive" | "delete",
  context: Parameters<typeof prepareSessionLifecycleDrain>[0]["context"],
  authorize?: () => void,
) {
  return prepareSessionLifecycleDrain({
    action,
    context,
    authorize,
    storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId: "main" }),
    sessionKeys: [parentKey],
    ...parentIdentity,
    defaultAgentId: "main",
    lifecycleIdentities: [parentKey, parentId],
  });
}

async function abortRequest(
  options: Omit<
    Parameters<typeof handleGatewayRequest>[0],
    "req" | "isWebchatConnect" | "extraHandlers" | "respond"
  > & { respond?: ReturnType<typeof vi.fn> },
  method: "chat.abort" | "sessions.abort" = "chat.abort",
  runId?: string,
) {
  const respond = options.respond ?? vi.fn();
  await handleGatewayRequest({
    ...options,
    respond,
    req: {
      type: "req",
      id: "stop",
      method,
      params:
        method === "chat.abort"
          ? { sessionKey: parentKey, ...(runId === undefined ? {} : { runId }) }
          : { key: parentKey, ...(runId === undefined ? {} : { runId }) },
    },
    isWebchatConnect: () => false,
    extraHandlers: {
      [method]:
        method === "chat.abort" ? handleChatAbortRequest : sessionAbortHandlers["sessions.abort"]!,
    },
  });
  return respond;
}

async function writeParent(profileId?: string) {
  const target = { agentId: "main", sessionKey: parentKey };
  await sessions.upsertSessionEntryCore(target, {
    sessionId: parentId,
    updatedAt: 1,
    createdActor: profileId ? { type: "human", source: "profile", id: profileId } : undefined,
  });
  return target;
}

async function prepareOwner(client: ReturnType<typeof roleClient>) {
  client.connect.scopes = ["operator.sessions.write"];
  const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
  setRuntimeConfigSnapshot(cfg);
  const catalog = await prepareUserProfileCatalog();
  return {
    context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
    [Symbol.dispose]: catalog.release,
  };
}

it.for(["controller", "reply-only"] as const)(
  "delete Stop drains %s replies",
  async (owner, { signal }) => {
    const runId = "delete-retained-reply";
    await seedEmbeddedSession(runId);
    const context = createDirectChatContext({ getRuntimeConfig });
    const registration =
      owner === "controller"
        ? registerParent(context, runId, {
            isAbortable: (entry) => isReplyRunAbortableForSignal(entry.controller.signal),
          })
        : undefined;
    const operation = createReplyOperation({
      ...parentIdentity,
      resetTriggered: false,
      upstreamAbortSignal: registration?.controller.signal,
    });
    retainReplyOperationUntilComplete(operation);
    const aborted = createDeferredCore();
    operation.abortSignal.addEventListener("abort", () => aborted.resolve(), { once: true });
    let drain: SessionLifecycleDrain | undefined;
    const pending = drainParent("delete", context).then((result) => {
      drain = result;
      return result;
    });
    const settled = Promise.allSettled([pending]);
    try {
      await withinTest(
        awaitGateBeforeSettlement(aborted.promise, pending, "Delete skipped the reply owner"),
        signal,
      );
      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(drain).toBeUndefined();
      if (registration) {
        expect(context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ runId, state: "aborted", stopReason: "delete" }),
          expect.anything(),
        );
      }
      operation.complete();
      registration?.cleanup();
      await withinTest(pending, signal);
      expect(drain?.hasAuthoritativeWork()).toBe(false);
    } finally {
      operation.complete();
      registration?.cleanup();
      await settled;
      drain?.release();
    }
  },
);

async function seedEmbeddedSession(runId: string, profileId?: string) {
  const target = await writeParent(profileId);
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
  "%s persists embedded Stop before responding",
  async (mode) => {
    const runId = "http-embedded-run";
    const target = await seedEmbeddedSession(runId);
    const context = createDirectChatContext({ getRuntimeConfig });
    using run = activeRun(runId, undefined, parentId, parentKey, "main");
    const registration = mode === "controller-backed" ? registerParent(context, runId) : undefined;
    registration?.markExecutionStarted();
    registration?.controller.signal.addEventListener("abort", run.abort, { once: true });
    let responseEntry: ReturnType<typeof sessions.loadSessionEntry>;
    const respond = vi.fn(() => {
      responseEntry = sessions.loadSessionEntry(target);
    });
    const method = mode === "sessions.abort" ? mode : "chat.abort";
    try {
      await withExecRequestTurn({ identity: { runId, ...parentIdentity } }, () =>
        abortRequest(
          { client: roleClient("write", "http-stop-operator"), context, respond },
          method,
        ),
      );
      expect(run.abort).toHaveBeenCalledTimes(1);
      expectReply(respond, method === "chat.abort" ? chatResult(runId) : sessionResult(runId));
      if (!registration) {
        expectKilled(responseEntry, runId);
        expect(context.dedupe.has(`chat:${runId}`)).toBe(false);
        expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
      }
    } finally {
      registration?.cleanup();
    }
  },
);

it.each(["revoked", "current"] as const)("archive fences %s Stop authority", async (authority) => {
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
      drain = await drainParent("archive", createDirectChatContext({ getRuntimeConfig }), () => {
        if (!current) {
          throw revoked;
        }
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
      expectKilled(after, runId);
    }
  } finally {
    drain?.release();
    clearActiveEmbeddedRun(parentId, handle, parentKey);
  }
});

it("worker cancellation leaves controller-less embedded work", async () => {
  const runId = "placement-embedded-run";
  const target = await seedEmbeddedSession(runId);
  const before = sessions.loadSessionEntry(target);
  using run = activeRun(runId, undefined, parentId, parentKey, "main");
  await cancelGatewayWorkerSessionWork(createDirectChatContext({ getRuntimeConfig }), {
    sessionId: parentId,
    sessionKeys: [parentKey],
    agentId: "main",
    assertCurrent: () => {},
  });
  expect(run.abort).not.toHaveBeenCalled();
  expect(sessions.loadSessionEntry({ ...target, readConsistency: "latest" })).toEqual(before);
});

it.each(["forbidden", "allowed"] as const)("chat.abort gates %s Stop", async (access) => {
  const owner = roleClient("none", "embedded-session-owner");
  const client = access === "allowed" ? owner : roleClient("none", "embedded-session-outsider");
  using ownerScope = await prepareOwner(client);
  const { context } = ownerScope;
  const runId = "shared-embedded-run";
  const target = await seedEmbeddedSession(runId, owner.authenticatedUserProfile!.profileId);
  const before = sessions.loadSessionEntry(target);
  expect(before).toMatchObject({ lifecycleRunId: runId, abortedLastRun: false });
  using run = activeRun(runId, undefined, parentId, parentKey, "main");
  const respond = await abortRequest({
    client,
    context,
  });
  expect(respond).toHaveBeenCalledOnce();
  const after = sessions.loadSessionEntry({ ...target, readConsistency: "latest" });
  if (access === "forbidden") {
    expect(run.abort).not.toHaveBeenCalled();
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
    expect(run.abort).toHaveBeenCalledOnce();
    expectKilled(after, runId);
    expectReply(respond, chatResult(runId));
  }
});

it.each(["before signal", "after signal"] as const)("chat Stop revoked %s", async (timing) => {
  const client = roleClient("none", "revoked-embedded-owner");
  client.connId = "revoked-embedded-connection";
  using ownerScope = await prepareOwner(client);
  const { context } = ownerScope;
  const runId = "revoked-embedded-run";
  const target = await seedEmbeddedSession(runId, client.authenticatedUserProfile!.profileId);
  const before = sessions.loadSessionEntry(target);
  expect(before).toMatchObject({ lifecycleRunId: runId, abortedLastRun: false });
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
  using run = activeRun(
    runId,
    vi.fn(() => {
      if (timing === "after signal") {
        current = false;
      }
    }),
    parentId,
    parentKey,
    "main",
  );
  const respond = vi.fn();
  const revoked = new Error("embedded Stop authority revoked");
  const outcome = await Promise.allSettled([
    abortRequest({
      client,
      context,
      respond,
      sessionMutationCommitGuard: () => {
        if (!current) {
          throw revoked;
        }
      },
    }),
  ]);
  expect(queued.controller.signal.aborted).toBe(true);
  expect(run.abort).toHaveBeenCalledTimes(timing === "after signal" ? 1 : 0);
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
});

it.each([
  ["chat.abort", "matched"],
  ["chat.abort", "old-incarnation"],
  ["chat.abort", "foreign-key"],
  ["sessions.abort", "matched"],
  ["sessions.abort", "old-incarnation"],
  ["sessions.abort", "foreign-key"],
  ["sessions.abort", "missing-row"],
] as const)("narrow %s checks %s embedded identity", async (method, target) => {
  const client = roleClient("view", "embedded-stop-owner");
  using ownerScope = await prepareOwner(client);
  const { context } = ownerScope;
  if (target !== "missing-row") {
    await writeParent(client.authenticatedUserProfile!.profileId);
  }
  const selectedId = target === "old-incarnation" ? "previous-parent" : parentId;
  const selectedKey = target === "foreign-key" ? "agent:main:foreign" : parentKey;
  const runId = method === "chat.abort" ? "narrow-embedded" : "selected-embedded";
  using run = activeRun(runId, undefined, selectedId, selectedKey);
  const respond = await abortRequest(
    { client, context },
    method,
    method === "sessions.abort" ? runId : undefined,
  );
  expect(run.abort).toHaveBeenCalledTimes(target === "matched" ? 1 : 0);
  if (method === "chat.abort") {
    expectReply(respond, chatResult(target === "matched" ? runId : null));
    return;
  }
  expect(respond).toHaveBeenCalledOnce();
  expect(respond.mock.calls[0]?.[0]).toBe(target === "matched");
  if (target === "matched") {
    expect(respond.mock.calls[0]?.[1]).toEqual(sessionResult(runId));
  } else {
    expect(context.dedupe.size).toBe(0);
    expect(context.chatQueuedTurns.size).toBe(0);
    expect(context.chatAbortControllers.size).toBe(0);
  }
});

it.each([false, true])("Stop uses captured owner (broad=%s)", async (broad) => {
  const client = roleClient("write", "late-embedded-stop-owner");
  client.connId = "late-embedded-stop";
  using ownerScope = await prepareOwner(client);
  const { context } = ownerScope;
  if (broad) {
    client.connect.scopes.push("operator.write");
  }
  await writeParent(client.authenticatedUserProfile!.profileId);
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
  try {
    const respond = await abortRequest({ client, context }, "sessions.abort");
    expect(queued.controller.signal.aborted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(broad ? 1 : 0);
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[1]).toEqual(sessionResult("original-queued"));
  } finally {
    clearActiveEmbeddedRun(parentId, successor, parentKey);
  }
});

const createParentContext = () =>
  createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
  });

async function stopParent(runId = "parent", context?: ReturnType<typeof createParentContext>) {
  const selectedContext = context ?? createParentContext();
  if (!context) {
    expect(selectedContext.chatAbortControllers.size).toBe(0);
  }
  const respond = vi.fn();
  await sessionAbortHandlers["sessions.abort"]!({
    req: { type: "req", id: "stop", method: "sessions.abort" },
    params: { key: parentKey, runId },
    respond,
    context: selectedContext as never,
    client: {
      connId: "operator",
      connect: { scopes: ["operator.read", "operator.write"] },
    } as never,
    isWebchatConnect: () => false,
  });
  return respond;
}

function seedParent() {
  return writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: parentKey,
    defaultSessionId: parentId,
  });
}

function enqueueCollector(
  groupId: string,
  runId: string,
  activeRunId: string,
  start = vi.fn(async () => {}),
) {
  enqueueSwarmRun({
    groupId,
    runId,
    start,
    activeRunIds: [activeRunId],
    maxConcurrent: 1,
    onStartFailure: () => true,
  });
  return start;
}

function endRun(runId: string, sessionId: string, sessionKey: string) {
  emitAgentEvent({
    runId,
    sessionId,
    sessionKey,
    stream: "lifecycle",
    data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
  });
}

async function seedChild(id: string, turn: string, queued = true, requester = parentKey) {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childKey(id),
    defaultSessionId: id,
    lifecycleRevision: `${id}-original`,
  });
  await registerSubagentRun({
    runId: id,
    childSessionKey: childKey(id),
    childAgentId: "main",
    sessionEntry: sessions.loadSessionEntry({ agentId: "main", sessionKey: childKey(id) }),
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

it("exact Stop cancels collectors without dispatching the queued sibling", async () => {
  await seedParent();
  await seedChild("running", "parent", false);
  await seedChild("queued", "parent");
  await seedChild("other-turn", "other-parent");
  await seedChild("other-session", "parent", true, "agent:main:direct:other");
  const queuedDispatch = enqueueCollector("selected", "queued", "running");
  const otherTurnDispatch = enqueueCollector("selected", "other-turn", "running");
  const otherSessionDispatch = enqueueCollector("unrelated", "other-session", "unrelated-capacity");
  const parentAbort = vi.fn(() => endRun("parent", parentId, parentKey));
  // The real lifecycle listener/cleanup releases the active collector slot.
  const childAbort = vi.fn(() => endRun("running", "running", childKey("running")));
  const parent = createEmbeddedRunHandle({ runId: "parent", abort: parentAbort });
  const child = createEmbeddedRunHandle({ runId: "running", abort: childAbort });
  setActiveEmbeddedRun(parentId, parent, parentKey);
  setActiveEmbeddedRun("running", child, childKey("running"));
  try {
    const respond = await stopParent();
    expect(respond).toHaveBeenCalledWith(true, sessionResult("parent"));
    expect(parentAbort).toHaveBeenCalledOnce();
    await fixture.settle();
    for (const id of ["running", "queued"]) {
      expect(await childRun(id), id).toMatchObject({
        endedReason: "subagent-killed",
      });
    }
    expect(childAbort).toHaveBeenCalledOnce();
    expect(queuedDispatch).not.toHaveBeenCalled();
    expect(isSwarmRunActive("running")).toBe(false);
    await vi.waitFor(() => expect(otherTurnDispatch).toHaveBeenCalledOnce());
    for (const id of ["other-turn", "other-session"]) {
      expect((await childRun(id))?.endedReason).toBeUndefined();
    }
    expect(otherSessionDispatch).not.toHaveBeenCalled();
    expect(releaseSwarmRun("unrelated-capacity")).toBe(true);
    await vi.waitFor(() => expect(otherSessionDispatch).toHaveBeenCalledOnce());
  } finally {
    clearActiveEmbeddedRun(parentId, parent, parentKey);
    clearActiveEmbeddedRun("running", child, childKey("running"));
  }
});

it.each(["replaced", "throwing", "unreadable child"])("%s Stop keeps children", async (state) => {
  await seedParent();
  await seedChild("queued", "parent");
  const dispatch = enqueueCollector("declined", "queued", "capacity");
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
    expectReply(respond, sessionResult(null));
    expect(abort).toHaveBeenCalledTimes(state === "throwing" ? 1 : 0);
    expect(replacementAbort).not.toHaveBeenCalled();
    expect(await childRun("queued")).toMatchObject({
      execution: { status: "queued" },
    });
    expect((await childRun("queued"))?.killIntent).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(releaseSwarmRun("capacity")).toBe(true);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  } finally {
    reader.mockRestore();
    clearActiveEmbeddedRun(parentId, state === "replaced" ? replacement : parent, parentKey);
  }
});

it.each([true, false])("controller Stop respects finalizing=%s", async (finalizing) => {
  await seedParent();
  await seedChild("running", "parent", false);
  await seedChild("queued", "parent");
  const dispatch = enqueueCollector("controller-backed", "queued", "running");
  const context = createParentContext();
  // Match native admission's retained abortability binding, including its
  // controller-removal cleanup; an absent native handle alone permits abort.
  expect(isEmbeddedAgentRunAbortableForRunId("parent")).toBe(true);
  const registration = registerParent(context, "parent", {
    ownerConnId: "operator",
    kind: "agent",
    isAbortable: () => isEmbeddedAgentRunAbortableForRunId("parent"),
    onRemoved: () => clearEmbeddedAgentRunAbortabilityForRunId("parent"),
  });
  expect(registration.registered).toBe(true);
  retainEmbeddedAgentRunAbortabilityForRunId("parent");
  const parentAbort = vi.fn();
  const parentState = { runId: "parent", abort: parentAbort, isAbortable: true };
  const parent = createEmbeddedRunHandle(parentState);
  const childAbort = vi.fn(() => endRun("running", "running", childKey("running")));
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
    const respond = await stopParent("parent", context);
    expectReply(respond, sessionResult(finalizing ? null : "parent"));
    expect(registration.controller.signal.aborted).toBe(!finalizing);
    expect(parentAbort).toHaveBeenCalledTimes(finalizing ? 0 : 1);
    await fixture.settle();
    expect.soft(childAbort).toHaveBeenCalledTimes(finalizing ? 0 : 1);
    expect(dispatch).not.toHaveBeenCalled();
    for (const id of ["running", "queued"]) {
      const run = await childRun(id);
      if (finalizing) {
        expect.soft(run?.endedReason, id).toBeUndefined();
        expect.soft(run?.killIntent, id).toBeUndefined();
      } else {
        expect(run, id).toMatchObject({ endedReason: "subagent-killed" });
      }
    }
    if (finalizing) {
      expect.soft(await childRun("queued")).toMatchObject({
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
});

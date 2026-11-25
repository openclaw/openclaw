/** Exact recovered-parent Stop owns its descendants, not other turns or queues. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { resolveActiveEmbeddedRunOwnerByRunId } from "../../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { releaseSwarmRun, isSwarmRunActive } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import * as sessionEntryRead from "../../config/sessions/session-entry-read-runtime.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import { withSessionControllerSource } from "../../sessions/session-controller.context.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { cancelGatewayWorkerSessionWork } from "../server-worker-placement-cancel.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import {
  prepareSessionLifecycleDrain,
  type SessionLifecycleDrain,
} from "./sessions-lifecycle-drain.js";
import { createEmbeddedSessionFixture } from "./sessions.abort-embedded.test-support.js";
import {
  abortContext,
  expectAbortFailure,
  expectCancelledSession,
  stopSession,
} from "./sessions.abort-lifecycle.test-support.js";

const fixture = useChatAbortRegistryFixture();
const parentKey = "agent:main:direct:embedded-parent";
const parentId = "embedded-parent-session";
const childKey = (id: string) => `agent:main:subagent:${id}`;
const parentIdentity = { sessionId: parentId, sessionKey: parentKey, agentId: "main" };
const { target: parentTarget, seed: seedEmbeddedSession } = createEmbeddedSessionFixture(
  parentKey,
  parentId,
);

function registerParent(runId: string) {
  return registerChatAbortController({
    ...parentIdentity,
    target: parentTarget(),
    runId,
    timeoutMs: 30_000,
  });
}

function drainParent(
  action: "delete" | "archive",
  context: Parameters<typeof prepareSessionLifecycleDrain>[0]["context"],
  authorize?: () => void,
) {
  return prepareSessionLifecycleDrain({
    ...parentIdentity,
    action,
    context,
    authorize,
    storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId: "main" }),
    sessionKeys: [parentKey],
    defaultAgentId: "main",
    lifecycleIdentities: [parentKey, parentId],
  });
}

function requestStop(
  method: "chat.abort" | "sessions.abort",
  client: Parameters<typeof handleGatewayRequest>[0]["client"],
  context: Parameters<typeof handleGatewayRequest>[0]["context"],
  respond: Parameters<typeof handleGatewayRequest>[0]["respond"],
  params: Record<string, unknown> = {},
  sessionMutationCommitGuard?: () => void,
) {
  return handleGatewayRequest({
    req: {
      type: "req",
      id: "stop",
      method,
      params: {
        ...(method === "chat.abort" ? { sessionKey: parentKey } : { key: parentKey }),
        ...params,
      },
    },
    client,
    context,
    respond,
    sessionMutationCommitGuard,
    isWebchatConnect: () => false,
    extraHandlers: {
      [method]: method === "chat.abort" ? handleChatAbortRequest : sessionAbortHandlers[method]!,
    },
  });
}

function expectStopResponse(respond: { mock: { calls: unknown[][] } }, payload: unknown) {
  expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([true, payload]);
}

async function prepareStopAccess(client: ReturnType<typeof roleClient>) {
  client.connect.scopes = ["operator.sessions.write"];
  const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
  setRuntimeConfigSnapshot(cfg);
  const catalog = await prepareUserProfileCatalog();
  return { client, cfg, [Symbol.dispose]: catalog.release };
}

function trackEmbeddedRun(...args: Parameters<typeof setActiveEmbeddedRun>) {
  setActiveEmbeddedRun(...args);
  return { [Symbol.dispose]: () => clearActiveEmbeddedRun(args[0], args[1], args[2]) };
}

function seedParent() {
  return fixture.writeSession(parentKey, parentId);
}

function endingEmbeddedRun(runId: string, sessionId: string, sessionKey: string) {
  const abort = vi.fn(() => {
    emitAgentEvent({
      runId,
      sessionKey,
      sessionId,
      stream: "lifecycle",
      data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
    });
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
  });
  const handle = createEmbeddedRunHandle({ runId, abort });
  return { handle, abort };
}

async function seedOwnedParent(client: ReturnType<typeof roleClient>) {
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

function enqueueCollector(
  groupId: string,
  runId: string,
  start: () => Promise<void>,
  active = "running",
) {
  fixture.queueRun({
    groupId,
    runId,
    start,
    activeRunIds: [active],
  });
}

it.for(["controller", "reply-only"] as const)(
  "delete drain records cancellation before settling a retained %s reply",
  async (owner, { signal }) => {
    const runId = "delete-retained-reply";
    await seedEmbeddedSession(runId);
    const context = createDirectChatContext({ getRuntimeConfig });
    const registration = owner === "controller" ? registerParent(runId) : undefined;
    const releaseClaim = registration?.registered
      ? await claimRpcSourceForTest(registration.entry)
      : undefined;
    const operation = registration?.registered
      ? registration.entry.input.claim!.operation!
      : createReplyOperation({
          ...parentIdentity,
          resetTriggered: false,
          target: parentTarget(),
        });
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
      releaseClaim?.();
      registration?.cleanup();
      await withinTest(pending, signal);
      expect(drain?.hasAuthoritativeWork()).toBe(false);
    } finally {
      operation.complete();
      releaseClaim?.();
      registration?.cleanup();
      await settled;
      drain?.release();
    }
  },
);

it.each(["chat.abort", "sessions.abort", "controller-backed"] as const)(
  "%s stops a live embedded turn and persists cancellation before responding",
  async (mode) => {
    const runId = "http-embedded-run";
    const target = await seedEmbeddedSession(runId);
    const context = createDirectChatContext({ getRuntimeConfig });
    const registration = mode === "controller-backed" ? registerParent(runId) : undefined;
    const releaseClaim = registration?.registered
      ? await claimRpcSourceForTest(registration.entry)
      : undefined;
    const operation = registration?.registered
      ? registration.entry.input.claim?.operation
      : undefined;
    const abort = vi.fn(() => {
      clearActiveEmbeddedRun(parentId, handle, parentKey);
      releaseClaim?.();
    });
    const handle = createEmbeddedRunHandle({ runId, abort });
    setActiveEmbeddedRun(parentId, handle, parentKey, undefined, "main", operation);
    registration?.markExecutionStarted();
    let responseEntry: ReturnType<typeof sessions.loadSessionEntry>;
    const respond = vi.fn(() => {
      responseEntry = sessions.loadSessionEntry(target);
    });
    const method = mode === "sessions.abort" ? mode : "chat.abort";
    try {
      await withExecRequestTurn({ identity: { runId, ...parentIdentity } }, async () => {
        const sendStop = () =>
          requestStop(method, roleClient("write", "http-stop-operator"), context, respond);
        await (registration?.entry
          ? withSessionControllerSource(registration.entry.input, sendStop)
          : sendStop());
      });
      expect(abort).toHaveBeenCalledTimes(1);
      expectStopResponse(
        respond,
        method === "chat.abort"
          ? { ok: true, aborted: true, runIds: [runId] }
          : { ok: true, abortedRunId: runId, status: "aborted" },
      );
      if (!registration) {
        expectCancelledSession(responseEntry, runId);
        expect(responseEntry?.lifecycleRunId).toBeUndefined();
        expect(context.dedupe.has(`chat:${runId}`)).toBe(false);
        expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
      }
    } finally {
      releaseClaim?.();
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
        expect(failure).toBe(revoked);
      } else {
        expect(failure).toBeUndefined();
        expect(drain?.hasAuthoritativeWork()).toBe(false);
        expectCancelledSession(after, runId);
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
  using _ = trackEmbeddedRun(parentId, handle, parentKey, undefined, "main");
  await cancelGatewayWorkerSessionWork(createDirectChatContext({ getRuntimeConfig }), {
    sessionId: parentId,
    sessionKeys: [parentKey],
    agentId: "main",
    assertCurrent: () => {},
  });
  expect(abort).not.toHaveBeenCalled();
  expect(sessions.loadSessionEntry({ ...target, readConsistency: "latest" })).toEqual(before);
});

it.each(["forbidden", "allowed"] as const)(
  "chat.abort enforces session access before embedded Stop effects (%s)",
  async (access) => {
    const owner = roleClient("none", "embedded-session-owner");
    const client = access === "allowed" ? owner : roleClient("none", "embedded-session-outsider");
    using accessScope = await prepareStopAccess(client);
    const { cfg } = accessScope;
    const runId = "shared-embedded-run";
    const target = await seedEmbeddedSession(runId, owner.authenticatedUserProfile!.profileId);
    const before = sessions.loadSessionEntry(target);
    expect(before).toMatchObject({ lifecycleRunId: runId, abortedLastRun: false });
    const abort = vi.fn(() => clearActiveEmbeddedRun(parentId, handle, parentKey));
    const handle = createEmbeddedRunHandle({ runId, abort });
    using _ = trackEmbeddedRun(parentId, handle, parentKey, undefined, "main");
    const respond = vi.fn();
    await requestStop(
      "chat.abort",
      client,
      createDirectChatContext({ getRuntimeConfig: () => cfg }),
      respond,
    );
    expect(respond).toHaveBeenCalledOnce();
    const after = sessions.loadSessionEntry({ ...target, readConsistency: "latest" });
    if (access === "forbidden") {
      expect(abort).not.toHaveBeenCalled();
      expect(after).toEqual(before);
      expectAbortFailure(respond, `Session "${parentKey}" was not found.`, "INVALID_REQUEST");
    } else {
      expect(abort).toHaveBeenCalledOnce();
      expectCancelledSession(after, runId);
      expect(after?.lifecycleRunId).toBeUndefined();
      expectStopResponse(respond, { ok: true, aborted: true, runIds: [runId] });
    }
  },
);

it.each(["before signal", "after signal"] as const)(
  "chat.abort fences embedded Stop effects when authority is revoked %s",
  async (timing) => {
    using access = await prepareStopAccess(roleClient("none", "revoked-embedded-owner"));
    const { client, cfg } = access;
    client.connId = "revoked-embedded-connection";
    const runId = "revoked-embedded-run";
    const target = await seedEmbeddedSession(runId, client.authenticatedUserProfile!.profileId);
    const before = sessions.loadSessionEntry(target);
    expect(before).toMatchObject({ lifecycleRunId: runId, abortedLastRun: false });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    let current = true;
    const abort = vi.fn(() => {
      if (timing === "after signal") {
        current = false;
      }
      clearActiveEmbeddedRun(parentId, handle, parentKey);
    });
    const handle = createEmbeddedRunHandle({ runId, abort });
    using _ = trackEmbeddedRun(parentId, handle, parentKey, undefined, "main");
    const queued = createActiveRun(parentKey, {
      runId: "authorized-queued",
      queued: true,
      sessionId: parentId,
      agentId: "main",
      owner: { connId: client.connId },
    });
    rpcSourceTesting.set("authorized-queued", queued);
    if (timing === "before signal") {
      queued.input.abortSignal.addEventListener(
        "abort",
        () => {
          current = false;
        },
        { once: true },
      );
    }
    const respond = vi.fn();
    const revoked = new Error("embedded Stop authority revoked");
    await expect(
      requestStop("chat.abort", client, context, respond, {}, () => {
        if (!current) {
          throw revoked;
        }
      }),
    ).rejects.toMatchObject({
      message: "Chat cancellation and persistence failed",
      errors: [revoked, revoked],
    });
    expect(queued.input.abortSignal.aborted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(timing === "after signal" ? 1 : 0);
    expect(sessions.loadSessionEntry({ ...target, readConsistency: "latest" })).toEqual(before);
    expect(respond).not.toHaveBeenCalled();
  },
);

it.each([
  ["chat.abort", "matched"],
  ["chat.abort", "old-incarnation"],
  ["chat.abort", "foreign-key"],
  ["sessions.abort", "matched"],
  ["sessions.abort", "old-incarnation"],
  ["sessions.abort", "foreign-key"],
  ["sessions.abort", "missing-row"],
] as const)(
  "narrow %s qualifies the exact %s embedded producer before effects",
  async (method, target) => {
    using access = await prepareStopAccess(roleClient("view", "embedded-stop-owner"));
    const { client, cfg } = access;
    if (target !== "missing-row") {
      await seedOwnedParent(client);
    }
    const selectedId = target === "old-incarnation" ? "previous-parent" : parentId;
    const selectedKey = target === "foreign-key" ? "agent:main:foreign" : parentKey;
    const abort = vi.fn(() => clearActiveEmbeddedRun(selectedId, handle, selectedKey));
    const handle = createEmbeddedRunHandle({ runId: "selected-embedded", abort });
    using _ = trackEmbeddedRun(selectedId, handle, selectedKey);
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const respond = vi.fn();
    await requestStop(
      method,
      client,
      context,
      respond,
      method === "sessions.abort" ? { runId: "selected-embedded" } : {},
    );
    expect(abort).toHaveBeenCalledTimes(target === "matched" ? 1 : 0);
    if (method === "chat.abort") {
      expectStopResponse(respond, {
        ok: true,
        aborted: target === "matched",
        runIds: target === "matched" ? ["selected-embedded"] : [],
      });
    } else {
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
        expect(rpcSourceTesting.size).toBe(0);
      }
    }
  },
);

it.each([false, true])(
  "session-wide Stop does not retarget a successor created during cancellation (broad=%s)",
  async (broad) => {
    const client = roleClient("write", "late-embedded-stop-owner");
    client.connId = "late-embedded-stop";
    client.connect.scopes = broad
      ? ["operator.write", "operator.sessions.write"]
      : ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    await seedOwnedParent(client);
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const queued = createActiveRun(parentKey, {
      queued: true,
      sessionId: parentId,
      agentId: "main",
      owner: { connId: client.connId },
    });
    rpcSourceTesting.set("original-queued", queued);
    const abort = vi.fn();
    const successor = createEmbeddedRunHandle({ runId: "late-successor", abort });
    let successorRegistration = Promise.resolve();
    let successorRegistered = false;
    queued.input.abortSignal.addEventListener(
      "abort",
      () => {
        successorRegistration = Promise.resolve().then(() => {
          setActiveEmbeddedRun(parentId, successor, parentKey);
          successorRegistered = true;
        });
      },
      { once: true },
    );
    const respond = vi.fn();
    try {
      await requestStop("sessions.abort", client, context, respond);
      await successorRegistration;
      expect(queued.input.abortSignal.aborted).toBe(true);
      expect(abort).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[1]).toEqual({
        ok: true,
        abortedRunId: "original-queued",
        status: "aborted",
      });
    } finally {
      if (successorRegistered) {
        clearActiveEmbeddedRun(parentId, successor, parentKey);
      }
    }
  },
);

async function stopParent(runId = "parent") {
  expect(rpcSourceTesting.size).toBe(0);
  const respond = vi.fn();
  await stopSession(parentKey, respond, abortContext(), { runId });
  return respond;
}

async function seedChild(id: string, turn: string, queued = true, requester = parentKey) {
  await fixture.seedRun({
    runId: id,
    sessionId: id,
    childSessionKey: childKey(id),
    lifecycleRevision: `${id}-original`,
    requesterSessionKey: requester,
    requesterTurnRunId: turn,
    queued,
  });
}

it("exact embedded Stop cancels running and queued collectors without dispatching the queued sibling", async () => {
  await seedParent();
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
    enqueueCollector("selected", runId, start);
  }
  enqueueCollector("unrelated", "other-session", otherSessionDispatch, "unrelated-capacity");
  const { handle: parent, abort: parentAbort } = endingEmbeddedRun("parent", parentId, parentKey);
  const { handle: child, abort: childAbort } = endingEmbeddedRun(
    "running",
    "running",
    childKey("running"),
  );
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

it.each(["missing", "replaced", "finalizing", "throwing", "unreadable child"])(
  "%s embedded Stop applies parent acceptance to descendants",

  async (state) => {
    await seedParent();
    await seedChild("queued", "parent");
    const dispatch = vi.fn(async () => {});
    enqueueCollector("declined", "queued", dispatch, "capacity");
    const abort = vi.fn(() => {
      if (state === "throwing") {
        clearActiveEmbeddedRun(parentId, parent, parentKey);
      }
      throw new Error("parent refused Stop");
    });
    const parent = createEmbeddedRunHandle({
      runId: "parent",
      abort,
      isAbortable: state !== "finalizing" && state !== "unreadable child",
    });
    const replacementAbort = vi.fn();
    const replacement = createEmbeddedRunHandle({ runId: "replacement", abort: replacementAbort });
    const parentOperation =
      state !== "missing" ? setActiveEmbeddedRun(parentId, parent, parentKey) : undefined;
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
      expectStopResponse(respond, {
        ok: true,
        abortedRunId: state === "throwing" ? "parent" : null,
        status: state === "throwing" ? "aborted" : "no-active-run",
      });
      expect(abort).toHaveBeenCalledTimes(state === "throwing" ? 1 : 0);
      expect(replacementAbort).not.toHaveBeenCalled();
      const queued = await getSubagentRunByChildSessionKey(childKey("queued"));
      if (state === "throwing") {
        expect(parentOperation?.result).toEqual({
          kind: "aborted",
          code: "aborted_by_user",
        });
        expect(parentOperation?.abortSignal.aborted).toBe(true);
        expect(queued).toMatchObject({ endedReason: "subagent-killed" });
        expect(isSwarmRunActive("queued")).toBe(false);
      } else {
        expect(queued).toMatchObject({ execution: { status: "queued" } });
        expect(queued?.killIntent).toBeUndefined();
      }
      expect(dispatch).not.toHaveBeenCalled();
      expect(releaseSwarmRun("capacity")).toBe(true);
      if (state === "throwing") {
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      }
    } finally {
      reader.mockRestore();
      clearActiveEmbeddedRun(parentId, state === "replaced" ? replacement : parent, parentKey);
    }
  },
);

it.each([true, false])(
  "sessions.abort controller-backed Stop respects parent acceptance (finalizing=%s)",
  async (finalizing) => {
    await seedParent();
    await seedChild("running", "parent", false);
    await seedChild("queued", "parent");
    const dispatch = vi.fn(async () => {});
    enqueueCollector("controller-backed", "queued", dispatch);
    const context = abortContext();
    const registration = registerChatAbortController({
      target: parentTarget(),
      ...parentIdentity,
      runId: "parent",
      ownerConnId: "operator",
      kind: "agent",
      timeoutMs: 30_000,
    });
    expect(registration.registered).toBe(true);
    if (!registration.registered) {
      throw new Error("Expected the parent abort controller to register");
    }
    let claim!: Parameters<typeof releaseSessionControllerClaim>[0];
    let operation!: ReturnType<typeof createReplyOperation>;
    await claimSessionControllerTask(registration.entry.input, (capturedClaim) => {
      claim = capturedClaim;
      operation = createReplyOperation({
        sessionKey: parentKey,
        sessionId: parentId,
        agentId: "main",
        resetTriggered: false,
        mailboxClaim: capturedClaim,
        target: registration.entry.input.target,
      });
    });
    const parentAbort = vi.fn(() => {
      clearActiveEmbeddedRun(parentId, parent, parentKey);
      operation.complete();
      releaseSessionControllerClaim(claim);
    });
    const parent = createEmbeddedRunHandle({ runId: "parent", abort: parentAbort });
    const { handle: child, abort: childAbort } = endingEmbeddedRun(
      "running",
      "running",
      childKey("running"),
    );
    setActiveEmbeddedRun(parentId, parent, parentKey, undefined, "main", operation);
    setActiveEmbeddedRun("running", child, childKey("running"));
    try {
      if (finalizing) {
        operation.freezeAbort();
      }
      expect(resolveActiveEmbeddedRunOwnerByRunId("parent")).toBeDefined();
      expect(rpcSourceTesting.get("parent")).toBe(registration.entry);
      const respond = vi.fn();
      await stopSession(parentKey, respond, context, { runId: "parent" });
      expectStopResponse(respond, {
        ok: true,
        abortedRunId: finalizing ? null : "parent",
        status: finalizing ? "no-active-run" : "aborted",
      });
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
      clearActiveEmbeddedRun(parentId, parent, parentKey);
      clearActiveEmbeddedRun("running", child, childKey("running"));
      operation.complete();
      releaseSessionControllerClaim(claim);
      registration.cleanup();
    }
  },
);

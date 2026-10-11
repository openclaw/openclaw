/** Session Stop reaches admitted runs before the embedded producer is registered. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { isAgentRunDirectAbortReason } from "../../agents/run-termination.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

useChatAbortRegistryFixture();
const parentKey = "agent:main:direct:embedded-parent";
const parentId = "embedded-parent-session";

async function seedAdmittedSession(runId: string, profileId: string) {
  const target = { agentId: "main", sessionKey: parentKey };
  await sessions.upsertSessionEntryCore(target, {
    sessionId: parentId,
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: profileId },
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

async function admitSessionRun(runId: string, interrupted?: () => void) {
  const controller = new AbortController();
  const onInterrupt = vi.fn((reason?: Error) => {
    if (controller.signal.aborted) {
      return undefined;
    }
    controller.abort(reason);
    interrupted?.();
    return { runId };
  });
  const admission = await beginSessionWorkAdmission({
    scope: resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId: "main" }),
    identities: [parentKey, parentId],
    run: { runId, sessionKey: parentKey, sessionId: parentId, agentId: "main" },
    onInterrupt,
    assertAllowed: () => {},
  });
  return { admission, controller, onInterrupt };
}

async function exerciseAdmittedStop(
  method: "chat.abort" | "sessions.abort",
  mode:
    | "live"
    | "controller-backed"
    | "old-incarnation"
    | "already-aborted"
    | "hidden"
    | "missing-session-id",
) {
  const runId = "http-admitted-run";
  const client = roleClient("write", "admitted-stop-operator");
  if (mode === "old-incarnation") {
    client.connect.scopes = ["operator.sessions.write"];
  }
  const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
  setRuntimeConfigSnapshot(cfg);
  const target = await seedAdmittedSession(runId, client.authenticatedUserProfile!.profileId);
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const controller = new AbortController();
  const originalReason = new Error("owner already stopped");
  if (mode === "already-aborted") {
    controller.abort(originalReason);
  }
  const onInterrupt = vi.fn((reason?: Error) => {
    if (controller.signal.aborted) {
      return undefined;
    }
    controller.abort(reason);
    return { runId };
  });
  const run = {
    runId,
    sessionKey: parentKey,
    sessionId:
      mode === "missing-session-id"
        ? undefined
        : mode === "old-incarnation"
          ? "previous-parent"
          : parentId,
    agentId: "main",
    controlUiVisible: mode !== "hidden",
  };
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
  const controllerAbort = vi.fn();
  registration?.controller.signal.addEventListener("abort", controllerAbort, { once: true });
  let responseEntry: ReturnType<typeof sessions.loadSessionEntry>;
  const respond = vi.fn<Parameters<typeof handleGatewayRequest>[0]["respond"]>(() => {
    responseEntry = sessions.loadSessionEntry(target);
  });
  try {
    await withExecRequestTurn({ identity: run }, async () => {
      const admission = await beginSessionWorkAdmission({
        scope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
        identities: [parentKey, run.sessionId],
        run,
        onInterrupt,
        assertAllowed: () => {},
      });
      try {
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "admitted-stop",
            method,
            params: method === "chat.abort" ? { sessionKey: parentKey } : { key: parentKey },
          },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: {
            "chat.abort": handleChatAbortRequest,
            "sessions.abort": sessionAbortHandlers["sessions.abort"]!,
          },
        });
      } finally {
        admission.release();
      }
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    if (mode === "live" || mode === "controller-backed") {
      expect(respond.mock.calls[0]?.[1]).toEqual(
        method === "chat.abort"
          ? { ok: true, aborted: true, runIds: [runId] }
          : { ok: true, abortedRunId: runId, status: "aborted" },
      );
    } else {
      expect(respond.mock.calls[0]?.[1]).toMatchObject(
        method === "chat.abort" ? { runIds: [] } : { abortedRunId: null },
      );
    }
    expect(onInterrupt).toHaveBeenCalledTimes(
      mode === "live" || mode === "already-aborted" ? 1 : 0,
    );
    if (mode === "live") {
      expect(isAgentRunDirectAbortReason(onInterrupt.mock.calls[0]?.[0])).toBe(true);
      expect(responseEntry).toMatchObject({
        status: "killed",
        abortedLastRun: true,
        lastRunId: runId,
      });
    }
    if (mode === "already-aborted") {
      expect(onInterrupt.mock.results[0]?.value).toBeUndefined();
      expect(controller.signal.reason).toBe(originalReason);
    }
    expect(controllerAbort).toHaveBeenCalledTimes(mode === "controller-backed" ? 1 : 0);
  } finally {
    registration?.cleanup();
  }
}

it.each(["chat.abort", "sessions.abort"] as const)(
  "%s stops an admitted controller-less run before its embedded handle exists",
  async (method) => {
    await exerciseAdmittedStop(method, "live");
  },
);

it.each([
  "controller-backed",
  "old-incarnation",
  "already-aborted",
  "hidden",
  "missing-session-id",
] as const)("admitted Stop preserves the %s boundary", async (mode) => {
  await exerciseAdmittedStop(mode === "old-incarnation" ? "sessions.abort" : "chat.abort", mode);
});

it.each(["forbidden", "allowed"] as const)(
  "chat.abort enforces session access before admitted Stop effects (%s)",
  async (access) => {
    const owner = roleClient("none", "admitted-session-owner");
    const client = access === "allowed" ? owner : roleClient("none", "admitted-session-outsider");
    client.connect.scopes = ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    const runId = "shared-admitted-run";
    const target = await seedAdmittedSession(runId, owner.authenticatedUserProfile!.profileId);
    const before = sessions.loadSessionEntry(target);
    expect(before).toMatchObject({ lifecycleRunId: runId, abortedLastRun: false });
    const { admission, onInterrupt } = await admitSessionRun(runId);
    const respond = vi.fn();
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "shared-admitted-stop",
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
        expect(onInterrupt).not.toHaveBeenCalled();
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
        expect(onInterrupt).toHaveBeenCalledOnce();
        expect(isAgentRunDirectAbortReason(onInterrupt.mock.calls[0]?.[0])).toBe(true);
        expect(after).toMatchObject({ status: "killed", abortedLastRun: true, lastRunId: runId });
        expect(after?.lifecycleRunId).toBeUndefined();
        expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
          true,
          { ok: true, aborted: true, runIds: [runId] },
        ]);
      }
    } finally {
      admission.release();
    }
  },
);

it.each(["before signal", "after signal"] as const)(
  "chat.abort fences admitted Stop effects when authority is revoked %s",
  async (timing) => {
    const client = roleClient("none", "revoked-admitted-owner");
    client.connId = "revoked-admitted-connection";
    client.connect.scopes = ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    const runId = "revoked-admitted-run";
    const target = await seedAdmittedSession(runId, client.authenticatedUserProfile!.profileId);
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
    const { admission, onInterrupt } = await admitSessionRun(runId, () => {
      if (timing === "after signal") {
        current = false;
      }
    });
    const respond = vi.fn();
    const revoked = new Error("admitted Stop authority revoked");
    try {
      const outcome = await Promise.allSettled([
        handleGatewayRequest({
          req: {
            type: "req",
            id: "revoked-admitted-stop",
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
      expect(onInterrupt).toHaveBeenCalledTimes(timing === "after signal" ? 1 : 0);
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
      admission.release();
    }
  },
);

it("chat.abort fences the second admitted interruption after the first revokes authority", async () => {
  const client = roleClient("none", "two-admission-owner");
  client.connect.scopes = ["operator.sessions.write"];
  const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
  setRuntimeConfigSnapshot(cfg);
  const firstRunId = "first-admitted-run";
  const target = await seedAdmittedSession(firstRunId, client.authenticatedUserProfile!.profileId);
  const before = sessions.loadSessionEntry(target);
  expect(before).toMatchObject({ lifecycleRunId: firstRunId, abortedLastRun: false });
  let current = true;
  const first = await admitSessionRun(firstRunId, () => {
    current = false;
  });
  const second = await admitSessionRun("second-admitted-run");
  const respond = vi.fn();
  const revoked = new Error("admitted Stop authority revoked");
  try {
    const outcome = await Promise.allSettled([
      handleGatewayRequest({
        req: {
          type: "req",
          id: "two-admission-stop",
          method: "chat.abort",
          params: { sessionKey: parentKey },
        },
        client,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
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
    expect(first.onInterrupt).toHaveBeenCalledOnce();
    expect(isAgentRunDirectAbortReason(first.onInterrupt.mock.calls[0]?.[0])).toBe(true);
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.onInterrupt).not.toHaveBeenCalled();
    expect(second.controller.signal.aborted).toBe(false);
    expect(sessions.loadSessionEntry({ ...target, readConsistency: "latest" })).toEqual(before);
    expect(respond).not.toHaveBeenCalled();
    expect(outcome).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({
          message: "Chat cancellation and persistence failed",
          errors: [revoked, revoked],
        }),
      },
    ]);
  } finally {
    first.admission.release();
    second.admission.release();
  }
});

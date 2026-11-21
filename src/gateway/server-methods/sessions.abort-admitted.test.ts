// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { beforeEach, expect, it, vi } from "vitest";
import { isAgentRunDirectAbortReason } from "../../agents/run-termination.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import { expectAbortFailure, revocableAuthority } from "./sessions.abort-lifecycle.test-support.js";

useChatAbortRegistryFixture();
const parentKey = "agent:main:direct:embedded-parent";
const parentId = "embedded-parent-session";
const target = { agentId: "main", sessionKey: parentKey };
const identity = { ...target, sessionId: parentId };
type Request = Parameters<typeof handleGatewayRequest>[0];
const storeScope = () =>
  resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId: "main" });
const readSession = () => sessions.loadSessionEntry({ ...target, readConsistency: "latest" });

beforeEach(() => setRuntimeConfigSnapshot({ ...getRuntimeConfig(), ...rolePolicyConfig() }));

function stop(
  options: Pick<Request, "client" | "respond" | "sessionMutationCommitGuard"> &
    Partial<Pick<Request, "context">>,
  method: "chat.abort" | "sessions.abort" = "chat.abort",
) {
  return handleGatewayRequest({
    req: {
      type: "req",
      id: "admitted-stop",
      method,
      params: method === "chat.abort" ? { sessionKey: parentKey } : { key: parentKey },
    },
    context: options.context ?? createDirectChatContext({ getRuntimeConfig }),
    isWebchatConnect: () => false,
    extraHandlers: {
      "chat.abort": handleChatAbortRequest,
      "sessions.abort": sessionAbortHandlers["sessions.abort"]!,
    },
    ...options,
  });
}

function interruptRun(runId: string, interrupted?: () => void) {
  const controller = new AbortController();
  const onInterrupt = vi.fn((reason?: Error) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
      interrupted?.();
      return { runId };
    }
    return undefined;
  });
  return { controller, onInterrupt };
}

async function seedAdmittedSession(runId: string, profileId: string) {
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
  const before = sessions.loadSessionEntry(target);
  expect(before).toMatchObject({ lifecycleRunId: runId, abortedLastRun: false });
  return before;
}

async function admitSessionRun(runId: string, interrupted?: () => void) {
  const { controller, onInterrupt } = interruptRun(runId, interrupted);
  const admission = await beginSessionEffect({
    scope: storeScope(),
    identities: [parentKey, parentId],
    run: { ...identity, runId },
    onInterrupt,
    assertAllowed: () => {},
  });
  return { admission, controller, onInterrupt };
}

it.each([
  ["chat.abort", "live"],
  ["sessions.abort", "live"],
  ["sessions.abort", "old-incarnation"],
  ["chat.abort", "already-aborted"],
  ["chat.abort", "hidden"],
  ["chat.abort", "missing-session-id"],
] as const)("%s preserves the %s admitted-run boundary", async (method, mode) => {
  const runId = "http-admitted-run";
  const client = roleClient("write", "admitted-stop-operator");
  if (mode === "old-incarnation") {
    client.connect.scopes = ["operator.sessions.write"];
  }
  await seedAdmittedSession(runId, client.authenticatedUserProfile!.profileId);
  const { controller, onInterrupt } = interruptRun(runId);
  const originalReason = new Error("owner already stopped");
  if (mode === "already-aborted") {
    controller.abort(originalReason);
  }
  const run = {
    ...identity,
    runId,
    sessionId:
      mode === "missing-session-id"
        ? undefined
        : mode === "old-incarnation"
          ? "previous-parent"
          : parentId,
    controlUiVisible: mode !== "hidden",
  };
  let ack: ReturnType<typeof sessions.loadSessionEntry>;
  const respond = vi.fn<Request["respond"]>(() => {
    ack = sessions.loadSessionEntry(target);
  });
  await withExecRequestTurn({ identity: run }, async () => {
    const admission = await beginSessionEffect({
      scope: storeScope(),
      identities: [parentKey, run.sessionId],
      run,
      onInterrupt,
      assertAllowed: () => {},
    });
    try {
      await stop({ client, respond }, method);
    } finally {
      admission.release();
    }
  });
  expect(respond).toHaveBeenCalledOnce();
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  if (mode === "live") {
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
  expect(onInterrupt).toHaveBeenCalledTimes(mode === "live" || mode === "already-aborted" ? 1 : 0);
  if (mode === "live") {
    expect(isAgentRunDirectAbortReason(onInterrupt.mock.calls[0]?.[0])).toBe(true);
    expect(ack).toMatchObject({ status: "killed", abortedLastRun: true, lastRunId: runId });
  }
  if (mode === "already-aborted") {
    expect(onInterrupt.mock.results[0]?.value).toBeUndefined();
    expect(controller.signal.reason).toBe(originalReason);
  }
});

it.each(["forbidden", "allowed"] as const)(
  "chat.abort enforces session access before admitted Stop effects (%s)",
  async (access) => {
    const owner = roleClient("none", "admitted-session-owner");
    const client = access === "allowed" ? owner : roleClient("none", "admitted-session-outsider");
    client.connect.scopes = ["operator.sessions.write"];
    const runId = "shared-admitted-run";
    const before = await seedAdmittedSession(runId, owner.authenticatedUserProfile!.profileId);
    const { admission, onInterrupt } = await admitSessionRun(runId);
    const respond = vi.fn();
    try {
      await stop({ client, respond });
      expect(respond).toHaveBeenCalledOnce();
      const after = readSession();
      if (access === "forbidden") {
        expect(onInterrupt).not.toHaveBeenCalled();
        expect(after).toEqual(before);
        expectAbortFailure(respond, `Session "${parentKey}" was not found.`, "INVALID_REQUEST");
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
    const runId = "revoked-admitted-run";
    const before = await seedAdmittedSession(runId, client.authenticatedUserProfile!.profileId);
    const queued = createActiveRun(parentKey, {
      ...identity,
      queued: true,
      runId: "authorized-queued",
      owner: { connId: client.connId },
    });
    rpcSourceTesting.set("authorized-queued", queued);
    const authority = revocableAuthority("admitted Stop authority revoked");
    if (timing === "before signal") {
      queued.input.abortSignal.addEventListener("abort", authority.revoke, { once: true });
    }
    const first = await admitSessionRun(runId, () => {
      if (timing !== "before signal") {
        authority.revoke();
      }
    });
    const respond = vi.fn();
    try {
      await expect(
        stop({
          client,
          respond,
          sessionMutationCommitGuard: authority.assertCurrent,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          message: "Chat cancellation and persistence failed",
          cause: authority.error,
          errors: [authority.error, authority.error],
        }),
      );
      expect(queued.input.abortSignal.aborted).toBe(true);
      expect(first.onInterrupt).toHaveBeenCalledTimes(timing === "before signal" ? 0 : 1);
      expect(readSession()).toEqual(before);
      expect(respond).not.toHaveBeenCalled();
    } finally {
      first.admission.release();
    }
  },
);

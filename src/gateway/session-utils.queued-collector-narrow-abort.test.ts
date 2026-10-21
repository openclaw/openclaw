import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  getCurrentSubagentRunOwner,
  subagentRuns,
} from "../agents/subagents/registry/subagent-registry-memory.js";
import { isSubagentRunQueued } from "../agents/subagents/registry/subagent-registry-read.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { getRpcSourceIdentity } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";
import { createRpcSourceForTest, claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

const { createQueuedReservation, requestContext, launchedRunIds } = useQueuedCollectorFixture();

async function reserve(name: string, profile: string) {
  const client = roleClient("view", profile);
  client.connId = "parent-requester";
  client.connect.scopes = ["operator.sessions.write"];
  setRuntimeConfigSnapshot({ ...getRuntimeConfig(), ...rolePolicyConfig() });
  const { entry } = await createQueuedReservation(name, {
    actor: { type: "human", source: "profile", id: client.authenticatedUserProfile!.profileId },
  });
  const loaded = await loadGatewaySessionEntryReadOnlyAsync(entry.childSessionKey);
  return { client, entry, loaded };
}

function abort(client: ReturnType<typeof roleClient>, key: string, context = requestContext()) {
  const respond = vi.fn();
  const done = handleGatewayRequest({
    req: { type: "req", id: "collector-stop", method: "sessions.abort", params: { key } },
    context,
    client,
    respond,
    isWebchatConnect: () => false,
    extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
  });
  return { respond, done };
}

it.each(["active", "queued", "pending-chat"] as const)(
  "narrow collector Stop preserves a same-key prior-incarnation %s producer",
  async (kind) => {
    const { client, entry, loaded } = await reserve("reserved", "collector-stop-owner");
    const childSession = expectDefined(loaded.entry, "collector session");
    expect(childSession.createdActor).toEqual({
      type: "human",
      source: "profile",
      id: client.authenticatedUserProfile!.profileId,
    });
    const descendant =
      kind === "queued"
        ? await createQueuedReservation(
            "nested-reserved",
            undefined,
            entry.childSessionKey,
            entry.runId,
          )
        : undefined;
    const descendantSession = descendant
      ? await loadGatewaySessionEntryReadOnlyAsync(descendant.entry.childSessionKey)
      : undefined;
    const source = (runId: string, sessionId: string) =>
      createRpcSourceForTest(
        { requester: { connectionId: client.connId } },
        {
          runId,
          sessionId,
          phase: "waiting",
          agentId: "main",
          storeScope: expectDefined(descendantSession, "descendant session").storePath,
          sessionKey: expectDefined(descendant, "descendant").entry.childSessionKey,
        },
      );
    const descendantSource = descendant
      ? source("prior-descendant-input", "previous-descendant-session")
      : undefined;
    const descendantOwnedSource = descendant
      ? source(
          "owned-descendant-input",
          expectDefined(descendantSession?.entry, "descendant session").sessionId,
        )
      : undefined;
    const context = requestContext();
    const oldRunId = "prior-incarnation-input";
    const old = createRpcSourceForTest(
      { requester: { connectionId: client.connId } },
      {
        runId: oldRunId,
        storeScope: loaded.storePath,
        phase: kind === "queued" ? "waiting" : "preparing",
        sessionKey: entry.childSessionKey,
        agentId: "main",
        sessionId: "previous-child-session",
      },
    );
    if (kind === "active") {
      await claimRpcSourceForTest(old);
      rpcSourceTesting.set(oldRunId, old);
      context.chatRunState.getOrCreate(oldRunId).buffer = "untouched old partial";
    } else if (kind === "queued") {
      rpcSourceTesting.set(oldRunId, old);
    } else {
      context.dedupe.set(`${kind}:${oldRunId}`, {
        ts: Date.now(),
        ok: true,
        payload: {
          runId: oldRunId,
          status: "accepted",
          ownerConnId: client.connId,
          agentId: "main",
          sessionKey: entry.childSessionKey,
          sessionId: getRpcSourceIdentity(old).sessionId,
        },
      });
    }
    const originalPending = context.dedupe.get(`${kind}:${oldRunId}`);
    const { respond, done } = abort(client, entry.childSessionKey, context);
    await done;
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[2]).toBeUndefined();
    expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
      true,
      { ok: true, status: "aborted", abortedRunId: entry.runId },
    ]);
    expect(isSubagentRunQueued(entry)).toBe(false);
    expect(getCurrentSubagentRunOwner(subagentRuns, entry)).toMatchObject({
      collectorCompletion: { status: "killed" },
    });
    expect(old.input.abortSignal.aborted).toBe(false);
    if (descendant && descendantSource) {
      expect(getCurrentSubagentRunOwner(subagentRuns, descendant.entry)).toMatchObject({
        collectorCompletion: { status: "killed" },
      });
      expect(descendantSource.input.abortSignal.aborted).toBe(false);
      expect(descendantOwnedSource?.input.abortSignal.aborted).toBe(true);
      await descendantOwnedSource?.input.settlement.promise;
    }

    if (kind === "active") {
      expect(context.chatRunState.resolveBuffer(oldRunId, { final: true }).text).toBe(
        "untouched old partial",
      );
    }
    if (kind !== "pending-chat") {
      expect(rpcSourceTesting.get(oldRunId)).toBe(old);
    } else {
      expect(context.dedupe.get(`${kind}:${oldRunId}`)).toBe(originalPending);
    }
    expect(launchedRunIds).toEqual([]);
  },
);

it("narrow collector Stop joins owned raw effects without interrupting or waiting for foreign effects", async () => {
  const { client, entry, loaded } = await reserve("effect-reserved", "collector-effect-owner");
  const sessionId = expectDefined(loaded.entry, "collector session").sessionId;
  const target = captureSessionTarget({
    storeScope: loaded.storePath,
    sessionKey: entry.childSessionKey,
    incarnation: sessionId,
  });
  const priorTarget = captureSessionTarget({ ...target, incarnation: "prior-incarnation" });
  const validationEntered = createDeferred();
  const validationFinish = createDeferred();
  const interrupted = createDeferred();
  const rawFinish = createDeferred();
  const priorInterrupted = vi.fn();
  const foreignInterrupted = vi.fn();
  const prior = beginSessionEffect({
    target: priorTarget,
    onInterrupt: priorInterrupted,
    assertAllowed: async () => {
      validationEntered.resolve();
      await validationFinish.promise;
    },
    // Hold preparation outside the writer needed by the current incarnation's effect.
    revalidateAllowed: () => {},
  });
  await validationEntered.promise;
  const foreign = await beginSessionEffect({
    target: captureSessionTarget({ ...target, storeScope: loaded.storePath + ".foreign" }),
    assertAllowed: () => {},
    onInterrupt: foreignInterrupted,
  });
  const foreignOperation = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId,
    resetTriggered: false,
    target: foreign.target,
  });
  const foreignAbort = vi.fn();
  const foreignNative = createEmbeddedRunHandle({
    runId: "foreign-store-run",
    abort: foreignAbort,
  });
  attachActiveEmbeddedRun(
    sessionId,
    foreignNative,
    target.sessionKey,
    undefined,
    undefined,
    foreignOperation,
  );
  const own = await beginSessionEffect({
    target,
    assertAllowed: () => {},
    onInterrupt: () => {
      own.release();
      interrupted.resolve();
      return { runId: entry.runId };
    },
  });
  const raw = own.run(async () => {
    await rawFinish.promise;
  });
  const { respond, done: stop } = abort(client, entry.childSessionKey);
  try {
    await interrupted.promise;
    expect(respond).not.toHaveBeenCalled();
    expect(priorInterrupted).not.toHaveBeenCalled();
    expect(foreignInterrupted).not.toHaveBeenCalled();
    rawFinish.resolve();
    await raw;
    await stop;
    expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
      true,
      { ok: true, status: "aborted", abortedRunId: entry.runId },
    ]);
    expect(priorInterrupted).not.toHaveBeenCalled();
    expect(foreign.isActive()).toBe(true);
    expect(foreignAbort).not.toHaveBeenCalled();
    expect(foreignOperation.abortSignal.aborted).toBe(false);
    expect(getCurrentSubagentRunOwner(subagentRuns, entry)).toMatchObject({
      collectorCompletion: { status: "killed" },
    });
  } finally {
    rawFinish.resolve();
    validationFinish.resolve();
    // Cleanup also settles the validator when a regression interrupted it.
    const priorEffect = await prior.catch(() => undefined);
    priorEffect?.release();
    detachActiveEmbeddedRun(sessionId, foreignNative, target.sessionKey);
    foreignOperation.complete();
    foreign.release();
    own.release();
    await Promise.all([raw, stop]);
  }
});

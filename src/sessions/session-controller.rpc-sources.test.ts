import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createQueueTestRun, createQueueSettings } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import {
  completeFollowupRunLifecycle,
  retireFollowupRunCancellation,
} from "../auto-reply/reply/queue/lifecycle.js";
import { registerChatAbortController as registerSource } from "../gateway/chat-abort.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayContextResolver as withGateway } from "../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { captureSessionTarget } from "./session-controller.lifecycle.js";
import {
  bindSessionControllerSource as bindSource,
  captureSessionControllerSourceSettlement as sourceSettlement,
  reserveSessionControllerSource as reserveSource,
} from "./session-controller.mailbox.js";
import {
  getReservedRpcSourceInput as reservedInput,
  getRpcSource,
  getRpcSourceForGateway as gatewaySource,
  getRpcSourceForSignal as signalSource,
  getRpcSourceIdentity as sourceIdentity,
  getRpcSourceProjectSessionActive as projectedActive,
  getRpcSourceStartedAt as startedAt,
  hasRpcSource,
  isRpcSourceActive,
  isRpcSourceQueued,
  listRpcSourceEntries,
  listRpcSourceEntriesForSession as sessionSources,
  requestRpcSourceCancellation as cancelSource,
  setRpcSourceProjectSessionActive as setProjectedActive,
  type RpcSourceRef,
} from "./session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "./session-controller.state.js";
import { testing as controllerTesting } from "./session-controller.test-support.js";
import { rpcSourceTesting } from "./session-lifecycle-admission.test-support.js";

const storeScope = "/synthetic/rpc-source-contracts/sessions.db";
const sessionKey = "agent:main:rpc-sources";
const sessionId = "rpc-source-session";
function registration(
  runId: string,
  target: ReturnType<typeof captureSessionTarget>,
  scope = { sessionKey, sessionId },
) {
  return { runId, ...scope, timeoutMs: 1, target };
}
afterEach(() => {
  controllerTesting.resetSessionControllerForTest();
  vi.useRealTimers();
});

function reserve(runId: string, scope = { sessionKey, sessionId, agentId: "main" }) {
  const target = captureSessionTarget({
    storeScope: scope.sessionKey === "global" ? storeScope + "/" + scope.agentId : storeScope,
    sessionKey: scope.sessionKey,
    incarnation: scope.sessionId,
    agentId: scope.agentId,
  });
  const registered = registerSource(registration(runId, target, scope));
  if (!registered.entry) {
    throw new Error("Expected fresh RPC source reservation");
  }
  return { ...registered, entry: registered.entry, target };
}

function runSource(ref: RpcSourceRef, run: Parameters<typeof withSessionTurn>[1]) {
  const identity = sourceIdentity(ref);
  return withSessionTurn(
    {
      sessionKey: identity.sessionKey,
      sessionId: identity.sessionId,
      storePath: storeScope,
      controllerInput: ref.input,
    },
    async (operation, signal) => {
      if (!operation) {
        throw new Error("Fixture requires a materialized turn");
      }
      markReplyOperationExecutionStarted(operation);
      operation.setPhase("running");
      return await run(operation, signal);
    },
  );
}

function state(ref: RpcSourceRef) {
  return {
    active: isRpcSourceActive(ref),
    projected: projectedActive(ref),
    queued: isRpcSourceQueued(ref),
    aborted: ref.input.abortSignal.aborted,
    startedAt: startedAt(ref),
  };
}
const settle = (...sources: ReturnType<typeof reserve>[]) =>
  Promise.all(sources.map(({ entry }) => sourceSettlement(entry.input)));

it("reserves before async preparation, then executes the same input rather than a second turn", async () => {
  const first = reserve("first");
  const prepared = createDeferred();
  const second = reserve("second");
  const order: string[] = [];
  const follower = runSource(second.entry, async () => {
    order.push("second");
  });
  expect(state(first.entry)).toMatchObject({ active: false, queued: true });
  expect(state(second.entry)).toMatchObject({ active: false });
  expect(order).toEqual([]);
  const leader = (async () => {
    await prepared.promise;
    await runSource(first.entry, async (operation) => {
      expect(first.entry.input.claim?.operation).toBe(operation);
      expect(first.entry.input.claim?.inputs).toEqual([first.entry.input]);
      expect(isRpcSourceActive(first.entry)).toBe(true);
      order.push("first");
    });
  })();
  prepared.resolve();
  await Promise.all([leader, follower]);
  expect(order).toEqual(["first", "second"]);
  first.cleanup();
  second.cleanup();
  await settle(first, second);
  expect(rpcSourceTesting.size).toBe(0);
});

it("cancels the exact claimed operation but retains retry custody until its producer settles", async () => {
  const source = reserve("active-source");
  const started = createDeferred();
  const release = createDeferred();
  const task = runSource(source.entry, async (operation, signal) => {
    expect(source.entry.input.claim?.operation).toBe(operation);
    expect(signal.aborted).toBe(false);
    started.resolve();
    await release.promise;
    expect(signal.aborted).toBe(true);
  });
  await started.promise;
  expect(cancelSource(source.entry)).toBe(true);
  expect(isRpcSourceActive(source.entry)).toBe(false);
  source.cleanup();
  expect(rpcSourceTesting.get("active-source")).toBe(source.entry);
  release.resolve();
  await task;
  await settle(source);
  expect(rpcSourceTesting.has("active-source")).toBe(false);
});

it("gives terminal projection precedence over an attached active operation", async () => {
  const source = reserve("terminal-precedence");
  await runSource(source.entry, async () => {
    setProjectedActive(source.entry, true);
    expect(state(source.entry)).toMatchObject({ projected: true, active: true });
    source.entry.adapter.projectSessionTerminalPending = true;
    expect(state(source.entry)).toMatchObject({ projected: false, active: false });
  });
  source.cleanup();
});

it("keeps byte-exact spaced protocol IDs distinct during cancellation and duplicate admission", () => {
  const spaced = reserve(" run ");
  const plain = reserve("run");
  const duplicate = registerSource(registration(" run ", spaced.target));
  expect(duplicate.registered).toBe(false);
  expect(cancelSource(spaced.entry)).toBe(true);
  expect(plain.entry.input.abortSignal.aborted).toBe(false);
  spaced.cleanup();
  expect([...rpcSourceTesting].map(([runId]) => runId)).toEqual(["run"]);
  plain.cleanup();
});

it("stale cancellation and cleanup cannot erase or cancel a successor with a reused run ID", () => {
  const first = reserve("reused");
  first.cleanup();
  const successor = reserve("reused");
  first.controller.abort();
  first.cleanup();
  expect(rpcSourceTesting.get("reused")).toBe(successor.entry);
  expect(successor.entry.input.abortSignal.aborted).toBe(false);
  successor.cleanup();
});

it("retains the exact source through cancellation and permits replacement after settlement", async () => {
  const first = reserve("reentrant");
  first.entry.adapter.cancel = () => {
    expect(rpcSourceTesting.get("reentrant")).toBe(first.entry);
    first.cleanup();
    expect(registerSource(registration("reentrant", first.target)).registered).toBe(false);
  };
  expect(cancelSource(first.entry, "rpc")).toBe(true);
  first.cleanup();
  await settle(first);
  const successor = reserve("reentrant");
  expect(rpcSourceTesting.get("reentrant")).toBe(successor.entry);
  expect(successor.entry.input.abortSignal.aborted).toBe(false);
  successor.cleanup();
});

it("keeps protocol IDs unique while selecting independent physical targets", () => {
  const firstScope = {
    sessionKey: "agent:first:main",
    sessionId: "first-session",
    agentId: "first",
  };
  const first = reserve("shared-run", firstScope);
  const other = {
    sessionKey: "agent:second:main",
    sessionId: "second-session",
    agentId: "second",
  };
  const second = reserve("second-run", other);
  const duplicate = registerSource(
    registration("shared-run", first.target, {
      sessionKey: firstScope.sessionKey,
      sessionId: firstScope.sessionId,
    }),
  );

  expect(duplicate).toMatchObject({ registered: false, existingEntry: first.entry });
  const foreignDuplicate = registerSource(registration("shared-run", second.target, other));
  expect([foreignDuplicate.registered, foreignDuplicate.existingEntry]).toEqual([false, undefined]);
  expect(hasRpcSource("shared-run")).toBe(true);
  expect(getRpcSource("shared-run")).toBe(first.entry);
  expect(gatewaySource("shared-run", undefined, second.target)).toBeUndefined();
  expect(gatewaySource("second-run", undefined, second.target)).toBe(second.entry);
  expect(listRpcSourceEntries()).toEqual([
    ["shared-run", first.entry],
    ["second-run", second.entry],
  ]);

  first.cleanup();
  expect(getRpcSource("shared-run")).toBeUndefined();
  expect(getRpcSource("second-run")).toBe(second.entry);
  second.cleanup();
});

it("keeps duplicate and reserved registrations inside their captured Gateway scope", () => {
  const resolveOuter: GatewayContextResolver = () => undefined;
  const resolveInner: GatewayContextResolver = () => undefined;
  withGateway(resolveOuter, () => {
    const outer = reserve("nested-run");
    const params = registration("nested-run", outer.target);
    withGateway(resolveInner, () => {
      const reserveInput = (protocolRunId?: string) =>
        reserveSource(sessionKey, {
          target: outer.target,
          protocolRunId,
          policy: { mode: "followup" },
        });
      const reserved = reserveInput(params.runId);
      expect(reservedInput(params.runId)).toBeUndefined();
      expect(reservedInput(params.runId, { resolveGatewayContext: resolveInner })).toBe(reserved);
      expect(reservedInput(params.runId, { resolveGatewayContext: undefined })).toBeUndefined();
      const inner = registerSource({ ...params, sourceInput: reserved });
      expect(inner.registered).toBe(true);
      expect(getRpcSource("nested-run")).toBeUndefined();
      expect(gatewaySource("nested-run", resolveInner, outer.target)).toBe(inner.entry);
      expect(gatewaySource("nested-run", resolveOuter)).toBe(outer.entry);
      expect(gatewaySource("nested-run", undefined)).toBeUndefined();
      expect(signalSource("nested-run", inner.controller.signal)).toBe(inner.entry);
      expect(signalSource("nested-run", outer.controller.signal)).toBe(outer.entry);
      expect(signalSource("nested-run", new AbortController().signal)).toBeUndefined();
      expect(registerSource(params)).toMatchObject({
        registered: false,
        existingEntry: inner.entry,
      });
      const duplicateReserved = reserveInput();
      expect(() => registerSource({ ...params, sourceInput: duplicateReserved })).toThrow(
        "Reserved source cannot adopt an existing RPC registration",
      );
      expect(duplicateReserved.custody.rpcAdopted).not.toBe(true);
      withGateway(resolveOuter, () => {
        expect(gatewaySource("nested-run", resolveOuter, outer.target)).toBe(outer.entry);
        expect(gatewaySource("nested-run", resolveInner)).toBe(inner.entry);
        expect(registerSource(params)).toMatchObject({
          registered: false,
          existingEntry: outer.entry,
        });
      });
      inner.cleanup();
      expect(gatewaySource("nested-run", resolveInner)).toBeUndefined();
      expect(hasRpcSource("nested-run")).toBe(true);
    });
    expect(getRpcSource("nested-run")).toBe(outer.entry);
    outer.cleanup();
  });
});

it("retains collected siblings as retry identities after retiring cancellation until aggregate settlement", async () => {
  const originals = [reserve("collect-a"), reserve("collect-b")];
  const runs = originals.map((source) => {
    const run = createQueueTestRun({ prompt: source.entry.input.protocolRunId! });
    bindSource(source.entry.input, run);
    expect(
      enqueueFollowupRun(sessionKey, run, createQueueSettings(), "none", undefined, false),
    ).toBe(true);
    retireFollowupRunCancellation(run);
    source.cleanup();
    return run;
  });
  for (const source of originals) {
    expect(cancelSource(source.entry)).toBe(false);
    expect(state(source.entry)).toMatchObject({ aborted: false, queued: false });
    expect(rpcSourceTesting.get(source.entry.input.protocolRunId!)).toBe(source.entry);
  }
  for (const run of runs) {
    completeFollowupRunLifecycle(run, "consumed");
  }
  await settle(...originals);
  expect(rpcSourceTesting.size).toBe(0);
});

it("lists only the captured logical session and agent", () => {
  reserve("main", { sessionKey: "global", sessionId: "global-main", agentId: "main" });
  reserve("other", { sessionKey: "global", sessionId: "global-other", agentId: "other" });
  const matches = sessionSources({
    sessionKeys: ["global"],
    agentId: "main",
    defaultAgentId: "main",
    requiredSessionId: "global-main",
    queuedOnly: true,
  });
  expect(matches.map(({ runId }) => runId)).toEqual(["main"]);
  expect(
    sessionSources({
      sessionKeys: ["wrong-session"],
      requiredSessionId: "global-main",
      queuedOnly: true,
    }),
  ).toEqual([]);
  for (const [runId] of rpcSourceTesting.entries()) {
    rpcSourceTesting.delete(runId);
  }
});

it("does not project a waiting source as active or start its execution clock while a predecessor prepares", async () => {
  vi.useFakeTimers();
  const predecessor = reserve("preparing");
  const waiting = reserve("waiting");
  const started = createDeferred();
  const release = createDeferred();
  const task = runSource(waiting.entry, async () => {
    started.resolve();
    await release.promise;
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state(waiting.entry)).toMatchObject({
    active: false,
    startedAt: undefined,
    aborted: false,
  });
  predecessor.cleanup();
  await started.promise;
  expect(state(waiting.entry)).toMatchObject({ active: true, startedAt: Date.now() });
  release.resolve();
  await task;
  waiting.cleanup();
});

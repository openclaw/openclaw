import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
/** Typed Stop exercises the real chat.send pipeline and collector cancellation owners. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as subagentControlSession from "../../agents/subagents/registry/subagent-control-session.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunQueued,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  activateSwarmRun,
  releaseSwarmRun,
  reserveSwarmRun,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntrySync,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { handleChatSend } from "./chat-send-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

const fixture = useChatAbortRegistryFixture();

function registeredRun(
  scope: { sessionKey: string } & Parameters<typeof createActiveRun>[1],
  runId: string,
  queued = false,
) {
  const run = createActiveRun(scope.sessionKey, { ...scope, runId, queued });
  registerRpcSource(runId, run);
  return run;
}

function expectChangedLeaf(respond: Awaited<ReturnType<typeof invokeChatAbortHandler>>) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
  );
}

function registerChild(
  scope: { sessionKey: string; agentId: string; storePath: string },
  runId: string,
  requesterSessionKey: string,
  options: Pick<Parameters<typeof registerSubagentRun>[0], "collect" | "queued"> = {},
) {
  return registerSubagentRun({
    runId,
    childSessionKey: scope.sessionKey,
    childAgentId: scope.agentId,
    sessionEntry: loadSessionEntryReadOnly(scope),
    requesterSessionKey,
    requesterAgentId: scope.agentId,
    requesterDisplayKey: requesterSessionKey,
    requesterTurnRunId: "parent",
    task: runId,
    cleanup: "keep",
    ...options,
    expectsCompletionMessage: false,
  });
}

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
  const context = createChatAbortContext({
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  const otherRun = registeredRun(other, "other-owner");
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
  const child = async (runId: string, requesterSessionKey = parent.sessionKey) => {
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
    await registerChild(scope, runId, requesterSessionKey, { collect: true, queued: true });
    const start = vi.fn(async () => {});
    activateSwarmRun({
      groupId,
      runId,
      start,
      onStartFailure: () => true,
    });
    return { ...scope, runId, start };
  };
  return { cfg, context, parent, other, otherRun, seed, send, child };
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

it("typed Stop preserves steer compatibility without touching the other owner", async () => {
  const test = createGuardedStopFixture();
  const selected = test.parent;
  appendStopCanary(selected, "current-leaf", "selected conversation");
  await waitForSessionTranscriptProjection(selected);
  const before = await loadTranscriptEvents(selected);
  const active = registeredRun(selected, "parent");
  const queued = registeredRun(selected, "queued", true);
  const respond = await test.send(selected.sessionKey, {
    expectedLeafEntryId: "stale",
    sessionId: "old",
    queueMode: "steer",
  });
  expect(respond).toHaveBeenCalledWith(true, {
    ok: true,
    aborted: true,
    runIds: ["queued", "parent"],
  });
  expect(active.input.abortSignal.aborted).toBe(true);
  expect(queued.input.abortSignal.aborted).toBe(true);
  expect(rpcSourceTesting.has("queued")).toBe(false);
  expect(test.otherRun.input.abortSignal.aborted).toBe(false);
  expect(loadSessionEntryReadOnly(test.other)?.sessionId).toBe(test.other.sessionId);
  expect(await loadTranscriptEvents(selected)).toEqual(before);
});

it.each(["replacement", "branch"] as const)(
  "typed Stop fences descendants after a parent %s and settles only its captured output",
  async (change) => {
    const test = createGuardedStopFixture();
    const child = await test.child("original-child");
    const parent = registeredRun(test.parent, "parent");
    test.context.chatRunState.getOrCreate("parent").buffer = "captured parent partial";
    let successor: ReturnType<typeof createActiveRun> | undefined;
    let successorQueue: ReturnType<typeof createActiveRun> | undefined;
    let successorChild: ReturnType<typeof test.child> | undefined;
    let replacement = test.parent;
    let callbackError: unknown;
    const changed = createDeferred();
    parent.input.abortSignal.addEventListener("abort", () => {
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
          successor = registeredRun(replacement, "successor");
          successorQueue = registeredRun(replacement, "successor-queued", true);
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
      expect(parent.input.abortSignal.aborted).toBe(true);
      expectChangedLeaf(respond);
      expect(successor?.input.abortSignal.aborted).toBe(false);
      expect(successorQueue?.input.abortSignal.aborted).toBe(false);
      expect(test.otherRun.input.abortSignal.aborted).toBe(false);
      expect(rpcSourceTesting.get("successor")).toBe(successor);
      expect(rpcSourceTesting.get("successor-queued")).toBe(successorQueue);
      const successorDescendant = await expectDefined(successorChild, "successor descendant");
      for (const selected of [child, successorDescendant]) {
        expect((await getSubagentRunByChildSessionKey(selected.sessionKey))?.execution.status).toBe(
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
        expect(successorDescendant.start).toHaveBeenCalledOnce();
      });
    } finally {
      try {
        await successorChild;
      } finally {
        for (const runId of ["original-child", "successor-child"]) {
          releaseSwarmRun(`${runId}-capacity`);
          releaseSwarmRun(runId);
        }
      }
    }
  },
);

it("typed Stop cannot acquire a replacement collector after cancellation preparation yields", async () => {
  const test = createGuardedStopFixture();
  const collector = await test.child("collector");
  expect(isSubagentRunQueued(getLatestLiveSubagentRunByChildSessionKey(collector.sessionKey))).toBe(
    true,
  );
  const descendant = await test.child("collector-descendant", collector.sessionKey);
  const old = registeredRun(collector, "old-collector");
  test.context.chatRunState.getOrCreate("old-collector").buffer = "old collector partial";
  const entered = createDeferred();
  const resume = createDeferred();
  const prepareSession = subagentControlSession.prepareSubagentKillSession;
  // Stop no longer waits for display rows; retain the real cancellation read across replacement.
  const readiness = vi
    .spyOn(subagentControlSession, "prepareSubagentKillSession")
    .mockImplementationOnce(async (...args) => {
      const prepared = await prepareSession(...args);
      entered.resolve();
      await resume.promise;
      return prepared;
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
          `Stop did not reach collector cancellation preparation: ${JSON.stringify(respond.mock.calls)}`,
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
    const successor = registeredRun(replacement, "successor-collector");
    const queued = registeredRun(replacement, "successor-queued", true);
    resume.resolve();
    const respond = await pending;
    expectChangedLeaf(respond);
    for (const run of [old, successor, queued, test.otherRun]) {
      expect(run.input.abortSignal.aborted).toBe(false);
    }
    expect(rpcSourceTesting.get("successor-queued")).toBe(queued);
    for (const child of [collector, descendant]) {
      expect((await getSubagentRunByChildSessionKey(child.sessionKey))?.execution.status).toBe(
        "queued",
      );
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
      for (const runId of ["collector", "collector-descendant"]) {
        releaseSwarmRun(`${runId}-capacity`);
        releaseSwarmRun(runId);
      }
    }
  }
});

it("typed Stop preserves ownership errors when the requested leaf is still active", async () => {
  const test = createGuardedStopFixture();
  const collector = await test.child("collector");
  const before = await getSubagentRunByChildSessionKey(collector.sessionKey);
  replaceSessionEntrySync(collector, {
    sessionId: collector.sessionId,
    lifecycleRevision: "successor",
    updatedAt: Date.now(),
  });
  const sessionBefore = loadSessionEntryReadOnly(collector);
  try {
    const respond = await test.send(collector.sessionKey, {
      expectedLeafEntryId: null,
      sessionId: collector.sessionId,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("Subagent original session incarnation"),
      }),
    );
    expect(await getSubagentRunByChildSessionKey(collector.sessionKey)).toEqual(before);
    expect(loadSessionEntryReadOnly(collector)).toEqual(sessionBefore);
    expect(collector.start).not.toHaveBeenCalled();
  } finally {
    releaseSwarmRun("collector-capacity");
    releaseSwarmRun("collector");
  }
});

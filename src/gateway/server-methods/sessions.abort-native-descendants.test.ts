// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { removeChatAbortControllerEntry } from "../chat-abort.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { abortControlledSubagents } from "./chat-abort-descendants.js";
import { createActiveRun, createChatAbortContext } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import type { RespondFn } from "./types.js";

const fixture = useChatAbortRegistryFixture();
const sessionKey = "agent:main:native-stop";
const sessionId = "native-parent-session";
const runId = "native-parent-run";
const lifecycleRevision = "original-incarnation";
const target = { agentId: "main", sessionKey };

function installHarness(hook: NonNullable<AgentHarness["withDescendantCancellation"]>) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "core",
    source: "runtime",
    harness: {
      id: "native-stop-test",
      label: "Native Stop fixture",
      supports: () => ({ supported: false }),
      runAttempt: async () => {
        throw new Error("No inference in cancellation proof");
      },
      withDescendantCancellation: hook,
    },
  });
  setActivePluginRegistry(registry);
}

afterEach(() => resetPluginRuntimeStateForTest());

async function seedYieldedParent() {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    ...target,
    defaultSessionId: sessionId,
    lifecycleRevision,
  });
  const startedAt = Date.now() - 100;
  for (const data of [
    { phase: "start", startedAt },
    {
      phase: "end",
      startedAt,
      endedAt: startedAt + 50,
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    },
  ]) {
    await persistGatewaySessionLifecycleEvent({
      ...target,
      event: {
        runId,
        sessionId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        ts: Date.now(),
        data,
      },
    });
  }
  expect(loadSessionEntry(target)?.status).toBeUndefined();
}

it.each([
  "cancelled",
  "natural success",
  "new run",
  "new revision",
  "failed settlement",
  "partial settlement",
  "retired owner",
] as const)(
  "registered sessions.abort preserves the %s outcome of a native-only yielded parent",
  async (race) => {
    await seedYieldedParent();
    const entered = createDeferred();
    const settled = createDeferred();
    const cancel = vi.fn(async () => {
      entered.resolve();
      await settled.promise;
      if (race === "failed settlement") {
        throw new Error("Native terminal was not confirmed");
      }
      return race === "natural success"
        ? { killed: 0, cancelledRequesters: [] }
        : {
            killed: 1,
            ...(race === "partial settlement"
              ? { errors: [new Error("Sibling cancellation failed")] }
              : {}),
            cancelledRequesters: [
              { ...target, sessionId, lifecycleRevision, requesterTurnRunId: runId },
            ],
          };
    });
    installHarness(async (params, run) => {
      expect(params).toMatchObject({ ...target, sessionId, lifecycleRevision });
      const result = await run(cancel);
      if (race === "retired owner") {
        setActivePluginRegistry(createEmptyPluginRegistry());
      }
      return result;
    });
    const respond = vi.fn<RespondFn>();
    const context = createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
    });
    const stop = Promise.resolve(
      sessionAbortHandlers["sessions.abort"]!({
        req: { type: "req", id: "stop", method: "sessions.abort" },
        params: { key: sessionKey },
        respond,
        context: context as never,
        client: {
          connId: "operator",
          connect: { scopes: ["operator.read", "operator.write"] },
        } as never,
        isWebchatConnect: () => false,
      }),
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, stop, "Stop skipped its registered harness");
      expect(respond).not.toHaveBeenCalled();
      const before = loadSessionEntry(target);
      if (!before) {
        throw new Error("Missing yielded requester");
      }
      if (race === "new revision") {
        await replaceSessionEntry(target, { ...before, lifecycleRevision: "replacement" });
      } else if (race === "new run" || race === "natural success") {
        await persistGatewaySessionLifecycleEvent({
          ...target,
          event: {
            runId: race === "new run" ? "replacement-run" : runId,
            sessionId,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            ts: Date.now(),
            data:
              race === "new run"
                ? { phase: "start", startedAt: Date.now() }
                : {
                    phase: "end",
                    startedAt: before.startedAt,
                    endedAt: Date.now(),
                    stopReason: "end_turn",
                  },
          },
        });
      }
      const expected = loadSessionEntry(target);
      settled.resolve();
      await stop;
      expect(cancel).toHaveBeenCalledOnce();
      if (
        race === "failed settlement" ||
        race === "partial settlement" ||
        race === "retired owner"
      ) {
        expect(respond.mock.calls[0]?.[0]).toBe(false);
      } else {
        expect(respond.mock.calls[0]?.[0]).toBe(true);
      }
      if (race === "cancelled" || race === "partial settlement" || race === "retired owner") {
        expect(loadSessionEntry(target)).toMatchObject({
          sessionId,
          lastRunId: runId,
          status: "killed",
          abortedLastRun: true,
        });
        expect(loadSessionEntry(target)?.lifecycleRunId).toBeUndefined();
      } else {
        expect(loadSessionEntry(target)).toEqual(expected);
      }
    } finally {
      settled.resolve();
      await stop;
    }
  },
);

it.each(["completed", "replaced", "retargeted", "queued successor"] as const)(
  "exact sessions.abort fences the %s outcome during native preparation",
  async (ending) => {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      ...target,
      defaultSessionId: sessionId,
      lifecycleRevision,
    });
    const context = createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
    });
    const parent = createActiveRun(sessionKey, { sessionId, agentId: "main" });
    const successor = createActiveRun(sessionKey, { sessionId, agentId: "main" });
    context.chatAbortControllers.set(runId, parent);
    const entered = createDeferred();
    const resume = createDeferred();
    const cancel = vi.fn(async () => ({ killed: 0, cancelledRequesters: [] }));
    installHarness(async (_params, run) => {
      entered.resolve();
      await resume.promise;
      return run(cancel);
    });
    const respond = vi.fn<RespondFn>();
    const stop = Promise.resolve(
      sessionAbortHandlers["sessions.abort"]!({
        req: { type: "req", id: "exact-stop", method: "sessions.abort" },
        params: { key: sessionKey, runId },
        respond,
        context: context as never,
        client: { connect: { scopes: ["operator.admin"] } } as never,
        isWebchatConnect: () => false,
      }),
    );
    void stop.catch(() => {});
    try {
      await awaitGateBeforeSettlement(entered.promise, stop, "Stop skipped native preparation");
      expect(respond).not.toHaveBeenCalled();
      if (ending === "retargeted") {
        parent.sessionId = "replacement-session";
      } else {
        removeChatAbortControllerEntry(context.chatAbortControllers, runId, parent);
        if (ending === "replaced") {
          context.chatAbortControllers.set(runId, successor);
        } else if (ending === "queued successor") {
          context.chatQueuedTurns.set(runId, successor);
        }
      }
      const session = loadSessionEntry(target);
      resume.resolve();
      if (ending === "completed") {
        await stop;
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          { ok: true, status: "no-active-run", abortedRunId: null },
          undefined,
          undefined,
        );
      } else {
        await expect(stop).rejects.toThrow("Run changed before cancellation; retry Stop.");
        expect(respond).not.toHaveBeenCalled();
      }
      expect(parent.controller.signal.aborted).toBe(false);
      expect(successor.controller.signal.aborted).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
      expect(loadSessionEntry(target)).toEqual(session);
    } finally {
      resume.resolve();
      await stop.catch(() => {});
    }
  },
);

it("does not consume registered native cancellation when the captured parent declines Stop", async () => {
  await seedYieldedParent();
  const cancel = vi.fn(async () => ({ killed: 0, cancelledRequesters: [] }));
  installHarness((_params, run) => run(cancel));
  const beforeKill = vi.fn(() => false);
  expect(
    await abortControlledSubagents({
      cfg: getRuntimeConfig(),
      ...target,
      sessionId,
      lifecycleRevision,
      requesterTurnRunId: runId,
      beforeKill,
    }),
  ).toBeUndefined();
  expect(beforeKill).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
});

it("stops a captured old embedded run when native preparation rejects after row replacement", async () => {
  await seedYieldedParent();
  const original = loadSessionEntry(target);
  if (!original) {
    throw new Error("Missing original requester");
  }
  const abort = vi.fn();
  const handle = createEmbeddedRunHandle({ runId, abort });
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
  await replaceSessionEntry(target, {
    ...original,
    sessionId: "replacement-session",
    lifecycleRevision: "replacement-revision",
    lifecycleRunId: "replacement-run",
  });
  const replacement = loadSessionEntry(target);
  const prepare = vi.fn(
    async (
      params: Parameters<NonNullable<AgentHarness["withDescendantCancellation"]>>[0],
    ): Promise<never> => {
      expect(params).toMatchObject({ sessionId, requesterTurnRunId: runId });
      expect(params.lifecycleRevision).toBeUndefined();
      throw new Error("Original native generation is unavailable");
    },
  );
  installHarness(prepare);
  const respond = vi.fn<RespondFn>();
  try {
    await sessionAbortHandlers["sessions.abort"]!({
      req: { type: "req", id: "exact-stop", method: "sessions.abort" },
      params: { key: sessionKey, runId },
      respond,
      context: createChatAbortContext({
        getRuntimeConfig,
        getSessionEventSubscriberConnIds: () => new Set(),
      }) as never,
      client: {
        connId: "operator",
        connect: { scopes: ["operator.read", "operator.write"] },
      } as never,
      isWebchatConnect: () => false,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("Original native generation is unavailable"),
      }),
    ]);
    expect(loadSessionEntry(target)).toEqual(replacement);
  } finally {
    clearActiveEmbeddedRun(sessionId, handle);
  }
});

it.each(["declined", "revoked"] as const)(
  "preserves the %s parent fence when native preparation rejects before callback entry",
  async (ending) => {
    await seedYieldedParent();
    let current = true;
    installHarness(async () => {
      if (ending === "revoked") {
        current = false;
      }
      throw new Error("Native preparation failed");
    });
    const beforeKill = vi.fn(() => false);
    const stop = abortControlledSubagents({
      cfg: getRuntimeConfig(),
      ...target,
      sessionId,
      lifecycleRevision,
      requesterTurnRunId: runId,
      beforeKill,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Stop authority revoked");
        }
      },
    });
    if (ending === "revoked") {
      await expect(stop).rejects.toThrow("Stop authority revoked");
      expect(beforeKill).not.toHaveBeenCalled();
    } else {
      expect(await stop).toBeUndefined();
      expect(beforeKill).toHaveBeenCalledOnce();
    }
    expect(loadSessionEntry(target)?.status).toBeUndefined();
  },
);

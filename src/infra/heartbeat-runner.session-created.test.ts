import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { captureExecRequestCancellation } from "../agents/bash-process-control.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { resetCronActiveJobs } from "../cron/active-jobs.js";
import { canRequesterAbortChatRun } from "../gateway/server-methods/chat-abort-authorization.js";
import { recordSessionCreated } from "../sessions/session-created.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as request from "./exec-request-context.js";
import { bindHeartbeatSend } from "./heartbeat-runner.boundary-test-support.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
} from "./heartbeat-runner.test-utils.js";
import * as deferredDelivery from "./outbound/deferred-delivery-admission.js";
import { loadPendingDeliveries } from "./outbound/delivery-queue.test-helpers.js";
import * as events from "./system-events.js";

type Owner = request.ExecRequestOwner;

let state: OpenClawTestState | undefined;
beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetCronActiveJobs();
  events.resetSystemEventsForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
  state = undefined;
  events.resetSystemEventsForTest();
});

function createGate() {
  const entered = createDeferred(),
    release = createDeferred();
  return {
    release: release.resolve,
    async pause() {
      entered.resolve();
      await release.promise;
    },
    async during<T>(pending: Promise<T>, signal: AbortSignal, check: () => Promise<void>) {
      try {
        await withinTest(awaitGateBeforeSettlement(entered.promise, pending, "entry gate"), signal);
        await check();
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    },
  };
}

async function createHeartbeatScenario(target: "none" | "telegram" = "none") {
  state = await createOpenClawTestState({
    label: "session-created-heartbeat",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  const storePath = path.join(state.root, "sessions.json");
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
        heartbeat: { every: "5m", target },
      },
    },
    plugins: { enabled: false },
    session: { store: storePath },
  });
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const sessionKey = await seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "-100155462274",
  });
  const run = (source: "cron" | "exec-event") =>
    runHeartbeatOnce({
      cfg,
      agentId: "main",
      sessionKey,
      source,
      reason: source === "cron" ? "cron:queue-check" : "exec-event",
      ...(source === "exec-event" ? { intent: "event" as const } : {}),
    });
  const humanReply = (Body: string) =>
    getReplyFromConfig(
      finalizeInboundContext({
        Body,
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:123",
        ChatType: "direct",
        SessionKey: sessionKey,
      }),
      undefined,
      cfg,
    );
  const enqueue = (text: string, owners?: readonly Owner[]) =>
    expectDefined(
      events.enqueueSystemEventEntry(text, request.withExecRequestOwners({ sessionKey }, owners)),
      "event occurrence",
    );
  const ownerFor = async (runId: string, extra: Partial<Owner["identity"]> = {}) => {
    const identity = {
      runId,
      sessionKey,
      sessionId: "sid",
      agentId: "main",
      ownerConnId: "original-connection",
      ...extra,
    };
    const owner = await request.withExecRequestTurn({ identity }, async () =>
      expectDefined(request.captureExecRequestOwners(identity)?.[0], "command request owner"),
    );
    return { identity, owner };
  };
  const readSession = () => sessionAccessor.loadSessionEntry({ storePath, sessionKey });
  const expectQueued = (
    expected: ReturnType<typeof events.peekSystemEventEntries>,
    deliverable = false,
  ) => {
    const peek = deliverable
      ? events.peekDeliverableSystemEventEntries
      : events.peekSystemEventEntries;
    expect(eventIds(peek(sessionKey))).toEqual(eventIds(expected));
  };
  return { cfg, sessionKey, run, humanReply, enqueue, ownerFor, readSession, expectQueued };
}

function eventIds(entries: ReturnType<typeof events.peekSystemEventEntries>) {
  return entries.map((event) => event.id);
}
function completedTurn(sessionId: string, text = "Handled internally") {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId, provider: "mock-openai", model: "gpt-5.6-luna" },
    },
  };
}
const mockAgent = () =>
  vi
    .spyOn(embeddedAgent, "runEmbeddedAgent")
    .mockImplementation(async (params) => completedTurn(params.sessionId));
const agentInput = (spy: ReturnType<typeof mockAgent>, index = 0) =>
  expectDefined(spy.mock.calls[index]?.[0], `agent input ${index}`);
const captureOwners = (input: Parameters<typeof embeddedAgent.runEmbeddedAgent>[0]) =>
  request.captureExecRequestOwners({ runId: input.runId, sessionId: input.sessionId });

it("delivers a creation notice once through a cron wake", async () => {
  const { cfg, sessionKey, run: runSource } = await createHeartbeatScenario();
  const title = "Investigate heartbeat wake";
  await recordSessionCreated(cfg, {
    sessionKey: "agent:main:dashboard:new-task",
    agentId: "main",
    entry: {
      sessionId: "new-task",
      updatedAt: Date.now(),
      label: title,
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: "profile-alice" },
    },
  });
  events.enqueueSystemEvent("Reminder: check the work queue", {
    sessionKey,
    contextKey: "cron:queue-check",
  });
  const runAgent = mockAgent();
  const run = () => runSource("cron");

  expect((await run()).status).toBe("ran");
  expect(runAgent).toHaveBeenCalledTimes(1);
  const input = agentInput(runAgent);
  expect(input.currentInboundContext?.text ?? "").toContain(title);
  expect(input.currentInboundContext?.text ?? "").toMatch(/System:.*New session created/u);
  expect(input.currentInboundContext?.fragments).toContainEqual(
    expect.objectContaining({ kind: "conversation-data", text: expect.stringContaining(title) }),
  );
  expect(input.prompt).toContain("The reminder content is:\n\nReminder: check the work queue");
  expect(input.prompt).not.toContain(title);
  expect(events.peekSystemEvents(sessionKey)).toEqual([]);

  expect((await run()).status).toBe("ran");
  expect(runAgent).toHaveBeenCalledTimes(2);
  const next = agentInput(runAgent, 1);
  expect(next.currentInboundContext?.text ?? "").not.toContain(title);
  expect(next.prompt).not.toContain(title);
});

it.for(["stopped", "failed"] as const)(
  "settles admitted generic events under a %s exec continuation",
  async (outcome, test) => {
    const { sessionKey, run, humanReply, enqueue, ownerFor, expectQueued } =
      await createHeartbeatScenario();
    const { identity, owner } = await ownerFor("original-command-request", {
      controlUiVisible: false,
      turnKind: "btw",
    });
    const completionText = "Exec completed (owned-command, code 0) :: ORIGINAL_COMMAND_RESULT";
    const completion = enqueue(completionText, [owner]);
    const peers = ["First notification", "Second notification"].map((text) => enqueue(text));
    const gate = createGate();
    let selectedOwners: readonly Owner[] | undefined;
    const runAgent = mockAgent().mockImplementation(async (params) => {
      selectedOwners = captureOwners(params);
      await gate.pause();
      if (outcome === "failed") {
        throw new Error("fixture model failure");
      }
      params.abortSignal?.throwIfAborted();
      return completedTurn(params.sessionId);
    });
    const pending = run("exec-event");
    await gate.during(pending, test.signal, async () => {
      expect(selectedOwners).toEqual([owner]);
      const input = agentInput(runAgent);
      const currentTarget = { sessionKey, sessionId: input.sessionId, agentId: "main" };
      const capture = (accept: (candidate: typeof owner.identity) => boolean) =>
        captureExecRequestCancellation(currentTarget, accept);
      const byConnection = (connId: string) =>
        capture((candidate) =>
          canRequesterAbortChatRun(
            {
              ...candidate,
              requester: {
                connectionId: candidate.ownerConnId,
                deviceId: candidate.ownerDeviceId,
              },
            },
            { connId, isAdmin: false },
          ),
        );
      const foreign = byConnection("foreign-connection");
      expect([foreign.owners, foreign.cancel()]).toEqual([[], false]);
      expect(capture((candidate) => candidate.controlUiVisible !== false).owners).toEqual([]);
      expect(capture((candidate) => candidate.turnKind !== "btw").owners).toEqual([]);
      expect(byConnection(identity.ownerConnId).owners).toEqual([owner]);
      const cancellation = captureExecRequestCancellation(identity);
      expect(cancellation.requestRunIds).toEqual([identity.runId, input.runId]);
      for (const peer of peers) {
        expect(input.currentInboundContext?.text).toContain(peer.text);
      }
      const late = enqueue("Late unrelated notification");
      if (outcome === "stopped") {
        expect(cancellation.cancel()).toBe(true);
        await cancellation.settle();
      }
      gate.release();
      const result = await pending;
      expectQueued(outcome === "stopped" ? [...peers, late] : [completion, late]);
      if (outcome === "failed") {
        expect([result.status, owner.signal.aborted]).toEqual(["failed", false]);
        return;
      }
      expect(result).toEqual({ status: "skipped", reason: "preempted" });
      expect(owner.signal.aborted).toBe(true);
      let nextOwners: readonly Owner[] | undefined;
      runAgent.mockImplementation(async (params) => {
        nextOwners = captureOwners(params);
        return completedTurn(params.sessionId);
      });
      const nextBody = "Start my next independent request";
      const nextReply = await humanReply(nextBody);
      const replies = Array.isArray(nextReply) ? nextReply : nextReply ? [nextReply] : [];
      expect(replies.map((reply) => reply.text)).toContain("Handled internally");
      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(nextOwners).toMatchObject([{ signal: { aborted: false } }]);
      expect(nextOwners).not.toContain(owner);
      const next = agentInput(runAgent, 1);
      expect(next.prompt).toContain(nextBody);
      expect(next.prompt).not.toContain(completionText);
      for (const peer of [...peers, late]) {
        expect(next.currentInboundContext?.text).toContain(peer.text);
      }
      expect(events.peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  },
);

it.for(["confirmed", "recovery-owned", "deferred admission abort"] as const)(
  "settles admitted generic events for a later human turn after %s",
  async (outcome, test) => {
    const { sessionKey, run, humanReply, enqueue, ownerFor, readSession, expectQueued } =
      await createHeartbeatScenario("telegram");
    const { identity, owner } = await ownerFor("generic-delivery");
    const completion = enqueue("Exec completed (delivery, code 0) :: COMMAND_RESULT", [owner]);
    const generic = enqueue("Admitted notification with its own delivery custody");
    const runAgent = mockAgent();
    const gate = createGate();
    const telegram = vi.fn(async (_to: string, _text: string) => ({
      messageId: "generic-delivery",
      chatId: "-100155462274",
    }));
    if (outcome === "confirmed") {
      const patch = sessionAccessor.patchSessionEntryCore;
      let gated = false;
      vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementation(async (...args) => {
        const result = await patch(...args);
        if (telegram.mock.calls.length === 1 && !gated) {
          gated = true;
          await gate.pause();
        }
        return result;
      });
    } else if (outcome === "recovery-owned") {
      telegram.mockImplementationOnce(async () => {
        await gate.pause();
        throw new Error("Synthetic response lost after platform dispatch");
      });
    } else {
      const prepare = deferredDelivery.prepareDeferredDeliveryAdmission;
      vi.spyOn(deferredDelivery, "prepareDeferredDeliveryAdmission").mockImplementationOnce(
        async (...args) => {
          const resolveAdmission = await prepare(...args);
          expect(args[0]).toMatchObject({ channel: "telegram", phase: "live" });
          await gate.pause();
          // The native admission function still observes Stop.
          return resolveAdmission;
        },
      );
    }
    bindHeartbeatSend("telegram", telegram);
    const pending = run("exec-event");
    await gate.during(pending, test.signal, async () => {
      const first = agentInput(runAgent);
      expect(first.currentInboundContext?.text).toContain(generic.text);
      const noSend = outcome === "deferred admission abort";
      let pendingFinalIdentity: { intentId: string; deliveryId: string } | undefined;
      if (noSend) {
        const source = readSession();
        expect(source?.sessionId).toBe(first.sessionId);
        const pendingFinal = expectDefined(source?.pendingFinalDelivery, "native pending final");
        expect(pendingFinal).toMatchObject({
          intentId: expect.any(String),
          deliveries: [{ id: expect.any(String), state: "queued" }],
        });
        pendingFinalIdentity = {
          intentId: expectDefined(pendingFinal.intentId, "native pending-final intent ID"),
          deliveryId: expectDefined(pendingFinal.deliveries?.[0], "native pending-final delivery")
            .id,
        };
        expect(telegram).not.toHaveBeenCalled();
        expect(await loadPendingDeliveries()).toEqual([]);
      }
      expectQueued([completion, generic]);
      const late = enqueue("Late notification for the next human turn");
      const cancellation = captureExecRequestCancellation(identity);
      expect(cancellation.cancel()).toBe(true);
      await cancellation.settle();
      gate.release();
      expect(await pending).toMatchObject({ status: "skipped" });
      expect(telegram).toHaveBeenCalledTimes(noSend ? 0 : 1);
      expectQueued(noSend ? [generic, late] : [late]);
      expectQueued(noSend ? [generic, late] : [late], true);
      const recovery = await loadPendingDeliveries();
      expect(recovery).toHaveLength(outcome === "recovery-owned" ? 1 : 0);
      if (outcome === "recovery-owned") {
        expect(recovery[0]?.recoveryState).toBe("unknown_after_send");
      } else if (noSend) {
        const previousFinal = expectDefined(pendingFinalIdentity, "captured native final identity");
        const source = readSession();
        expect(source?.pendingFinalDelivery).toMatchObject({
          intentId: previousFinal.intentId,
          deliveries: [{ id: previousFinal.deliveryId, state: "unknown" }],
        });
      }

      const nextBody = "Handle only my new instruction";
      await humanReply(nextBody);
      expect(runAgent).toHaveBeenCalledTimes(2);
      const next = agentInput(runAgent, 1);
      expect(next.prompt).toContain(nextBody);
      expect((next.currentInboundContext?.text ?? "").includes(generic.text)).toBe(noSend);
      expect(next.currentInboundContext?.text).toContain(late.text);
      expect(events.peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(telegram).toHaveBeenCalledTimes(noSend ? 0 : 1);
    });
  },
);

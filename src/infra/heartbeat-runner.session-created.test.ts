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
import { resetCronActiveJobs } from "../cron/active-jobs.js";
import { canRequesterAbortChatRun } from "../gateway/server-methods/chat-abort-authorization.js";
import { recordSessionCreated } from "../sessions/session-created.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  captureExecRequestOwners,
  withExecRequestOwners,
  withExecRequestTurn,
  type ExecRequestOwner,
} from "./exec-request-context.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
} from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

let state: OpenClawTestState | undefined;
beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetCronActiveJobs();
  resetSystemEventsForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
  state = undefined;
  resetSystemEventsForTest();
});

async function createHeartbeatScenario() {
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
        heartbeat: { every: "5m", target: "none" },
      },
    },
    plugins: { enabled: false },
    session: { store: storePath },
  });
  await state.writeConfig(cfg);
  const sessionKey = await seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "-100155462274",
  });
  return { cfg, sessionKey };
}

function completedTurn(sessionId: string) {
  return {
    payloads: [{ text: "Handled internally" }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId, provider: "mock-openai", model: "gpt-5.6-luna" },
    },
  };
}

it.each(["heartbeat wake"])(
  "delivers a creation notice about %s once through a cron wake",
  async (topic) => {
    const { cfg, sessionKey } = await createHeartbeatScenario();
    const title = `Investigate ${topic}`;
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
    enqueueSystemEvent("Reminder: check the work queue", {
      sessionKey,
      contextKey: "cron:queue-check",
    });
    const runAgent = vi
      .spyOn(embeddedAgent, "runEmbeddedAgent")
      .mockImplementation(async (params) => completedTurn(params.sessionId));
    const run = () =>
      runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "cron",
        reason: "cron:queue-check",
        deps: { getReplyFromConfig },
      });

    expect((await run()).status).toBe("ran");
    expect(runAgent).toHaveBeenCalledTimes(1);
    const input = expectDefined(runAgent.mock.calls[0]?.[0], "first agent input");
    expect(input.currentInboundContext?.text ?? "").toContain(title);
    expect(input.currentInboundContext?.text ?? "").toMatch(/System:.*New session created/u);
    expect(input.currentInboundContext?.fragments).toContainEqual(
      expect.objectContaining({ kind: "conversation-data", text: expect.stringContaining(title) }),
    );
    expect(input.prompt).toContain("The reminder content is:\n\nReminder: check the work queue");
    expect(input.prompt).not.toContain(title);
    expect(peekSystemEvents(sessionKey)).toEqual([]);

    expect((await run()).status).toBe("ran");
    expect(runAgent).toHaveBeenCalledTimes(2);
    const next = expectDefined(runAgent.mock.calls[1]?.[0], "second agent input");
    expect(next.currentInboundContext?.text ?? "").not.toContain(title);
    expect(next.prompt).not.toContain(title);
  },
);

it.for(["stopped", "failed"] as const)(
  "settles admitted generic events under a %s exec continuation",
  async (outcome, test) => {
    const { cfg, sessionKey } = await createHeartbeatScenario();
    const identity = {
      runId: "original-command-request",
      sessionKey,
      sessionId: "sid",
      agentId: "main",
      ownerConnId: "original-connection",
      controlUiVisible: false,
      turnKind: "btw" as const,
    };
    const owner = await withExecRequestTurn({ identity }, async () =>
      expectDefined(captureExecRequestOwners(identity)?.[0], "original command owner"),
    );
    const completionText = "Exec completed (owned-command, code 0) :: ORIGINAL_COMMAND_RESULT";
    const completion = expectDefined(
      enqueueSystemEventEntry(completionText, withExecRequestOwners({ sessionKey }, [owner])),
      "command completion occurrence",
    );
    const peers = ["First unrelated notification", "Second unrelated notification"].map((text) =>
      expectDefined(enqueueSystemEventEntry(text, { sessionKey }), "generic occurrence"),
    );
    const entered = createDeferred();
    const release = createDeferred();
    let selectedOwners: readonly ExecRequestOwner[] | undefined;
    const runAgent = vi
      .spyOn(embeddedAgent, "runEmbeddedAgent")
      .mockImplementation(async (params) => {
        selectedOwners = captureExecRequestOwners({
          runId: params.runId,
          sessionId: params.sessionId,
        });
        entered.resolve();
        await release.promise;
        if (outcome === "failed") {
          throw new Error("fixture model failure");
        }
        params.abortSignal?.throwIfAborted();
        return completedTurn(params.sessionId);
      });
    const pending = runHeartbeatOnce({
      cfg,
      agentId: "main",
      sessionKey,
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      deps: { getReplyFromConfig },
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, pending, "heartbeat settled before model entry"),
        test.signal,
      );
      expect(selectedOwners).toEqual([owner]);
      expect(selectedOwners?.[0]?.identity).toEqual(identity);
      const input = expectDefined(runAgent.mock.calls[0]?.[0], "continuation model input");
      const currentTarget = { sessionKey, sessionId: input.sessionId, agentId: "main" };
      const capture = (accept: (candidate: typeof owner.identity) => boolean) =>
        captureExecRequestCancellation(currentTarget, accept);
      const foreign = capture((candidate) =>
        canRequesterAbortChatRun(candidate, { connId: "foreign-connection", isAdmin: false }),
      );
      expect(foreign.owners).toEqual([]);
      expect(foreign.cancel()).toBe(false);
      expect(capture((candidate) => candidate.controlUiVisible !== false).owners).toEqual([]);
      expect(capture((candidate) => candidate.turnKind !== "btw").owners).toEqual([]);
      expect(
        capture((candidate) =>
          canRequesterAbortChatRun(candidate, {
            connId: identity.ownerConnId,
            isAdmin: false,
          }),
        ).owners,
      ).toEqual([owner]);
      const cancellation = captureExecRequestCancellation(identity);
      expect(cancellation.requestRunIds).toEqual([identity.runId, input.runId]);
      for (const peer of peers) {
        expect(input.currentInboundContext?.text).toContain(peer.text);
      }
      const late = expectDefined(
        enqueueSystemEventEntry("Late unrelated notification", { sessionKey }),
        "late generic occurrence",
      );
      if (outcome === "stopped") {
        expect(cancellation.cancel()).toBe(true);
        await cancellation.settle();
      }
      release.resolve();
      const result = await pending;
      expect(peekSystemEventEntries(sessionKey).map((event) => event.id)).toEqual(
        (outcome === "stopped" ? [...peers, late] : [completion, late]).map((event) => event.id),
      );
      if (outcome === "failed") {
        expect(result.status).toBe("failed");
        expect(owner.signal.aborted).toBe(false);
        return;
      }
      expect(result).toEqual({ status: "skipped", reason: "preempted" });
      expect(owner.signal.aborted).toBe(true);
      let nextOwners: readonly ExecRequestOwner[] | undefined;
      runAgent.mockImplementation(async (params) => {
        nextOwners = captureExecRequestOwners({
          runId: params.runId,
          sessionId: params.sessionId,
        });
        return completedTurn(params.sessionId);
      });
      const nextBody = "Start my next independent request";
      const nextReply = await getReplyFromConfig(
        finalizeInboundContext({
          Body: nextBody,
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
      const replies = Array.isArray(nextReply) ? nextReply : nextReply ? [nextReply] : [];
      expect(replies.map((reply) => reply.text)).toContain("Handled internally");
      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(nextOwners).toHaveLength(1);
      expect(nextOwners).not.toContain(owner);
      expect(nextOwners?.[0]?.signal.aborted).toBe(false);
      const next = expectDefined(runAgent.mock.calls[1]?.[0], "later model input");
      expect(next.prompt).toContain(nextBody);
      expect(next.prompt).not.toContain(completionText);
      for (const peer of [...peers, late]) {
        expect(next.currentInboundContext?.text).toContain(peer.text);
      }
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  },
);

/* @vitest-environment jsdom */

import { createComponent, createMemo, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { createChatViewFrame } from "./chat-view-frame.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { ChatThread } from "./components/chat-thread-view.tsx";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  requireElement,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { hasAbortableSessionRun } from "./run-lifecycle.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

describe("mounted pane run settlement", () => {
  it("retains the watched recap while a terminal descriptor outlives the status mask", async () => {
    const startedAt = Date.now();
    const runId = "managed-media-run";
    const running: GatewaySessionRow = {
      key: "agent:main:managed-media-recap",
      agentId: "main",
      sessionId: "managed-media-recap",
      kind: "direct",
      updatedAt: startedAt,
      lastRunId: runId,
      status: "running",
      hasActiveRun: true,
    };
    const prompt = {
      role: "user",
      content: "Show the generated image.",
      timestamp: startedAt,
      __openclaw: { id: "managed-media-prompt", idempotencyKey: `${runId}:user` },
    };
    const finalMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Here is the generated image." },
        {
          type: "image",
          data: "cG5n",
          mimeType: "image/png",
          artifactId: "artifact_managed_image_recap-proof",
        },
      ],
      timestamp: startedAt + 1_000,
      stopReason: "stop",
      __openclaw: { id: "managed-media-answer", seq: 2, runId, runTerminal: true },
    };
    const done: GatewaySessionRow = {
      ...running,
      updatedAt: startedAt + 1_000,
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
      endedAt: startedAt + 1_000,
      runtimeMs: 1_000,
    };
    const terminalDescriptor = createDeferred<{ session: GatewaySessionRow }>();
    let delayDescriptor = false;
    const { sessions, mount, emitGatewayEvent } = createMountedPanes([running], "main", undefined, {
      "sessions.describe": () =>
        delayDescriptor ? terminalDescriptor.promise : { session: running },
      "chat.startup": () => ({
        messages: [prompt],
        sessionInfo: running,
        sessionId: running.sessionId,
        inFlightRun: { runId, text: "Preparing the image.", startedAt },
      }),
      "chat.history": () => ({
        messages: [prompt],
        sessionInfo: running,
        sessionId: running.sessionId,
        inFlightRun: { runId, text: "Preparing the image.", startedAt },
      }),
    });
    await sessions.refresh({ agentId: "main", force: true });
    const pane = mount(running.key);
    await refreshPane(pane);
    const transcript = createTestTranscript(pane.presentationId);
    const readProps = () => {
      const chat = pane.render().layout?.primary.chat;
      if (!chat) {
        throw new Error("Expected the mounted chat pane");
      }
      return { ...chat, transcript, presented: true, transcriptVisible: true };
    };
    const [props, setProps] = createSignal(readProps());
    const view = mountSolid(() => {
      const questions = createComposerQuestions(pane.presentationId, props);
      const frame = createMemo(() =>
        createChatViewFrame(props(), () => undefined, questions.source()!.asyncQuestions),
      );
      return createComponent(ChatThread, {
        get props() {
          return frame().threadProps;
        },
        transcript,
      });
    });
    const draw = () => {
      setProps(readProps());
      flush();
      transcript.update();
      flush();
    };
    onTestFinished(() => {
      vi.useRealTimers();
      terminalDescriptor.resolve({ session: done });
      view.unmount();
      transcript.dispose();
    });
    transcript.start();
    draw();
    await flushDeferredRowPrune();
    expect(pane.state.chatRunId).toBe(runId);
    expect(view.container.querySelector(".chat-working-indicator")).not.toBeNull();

    // History's terminal-persistence view can be active without an exact run set.
    const observation = sessions.observeRow({ key: running.key, agentId: "main" }, () => {});
    onTestFinished(observation.dispose);
    const reconcileDescriptor = observation.captureReconcile();
    delayDescriptor = true;
    const descriptorRead = sessions
      .describe({ key: running.key, agentId: "main" }, { refresh: true })
      .then(({ session }) => reconcileDescriptor(session ?? undefined));
    vi.useFakeTimers({ now: startedAt + 1_000 });
    emitGatewayEvent("chat", {
      sessionKey: running.key,
      agentId: "main",
      runId,
      seq: 2,
      state: "final",
      message: finalMessage,
    });
    draw();
    expect(pane.state.chatRunId).toBeNull();
    expect(view.container.querySelector(".chat-working-indicator")).toBeNull();
    const bubble = requireElement(view.container, '[data-entry-id="managed-media-answer"]');
    expect(view.container.querySelector(".chat-turn-recap")).toBeNull();

    await vi.advanceTimersByTimeAsync(5_001);
    draw();
    expect(pane.state.chatRunId).toBeNull();
    expect(view.container.querySelector(".chat-working-indicator")).not.toBeNull();
    expect(view.container.querySelector(".chat-turn-recap")).toBeNull();

    terminalDescriptor.resolve({ session: done });
    await descriptorRead;
    draw();
    expect(view.container.querySelector('[data-entry-id="managed-media-answer"]')).toBe(bubble);
    expect(view.container.querySelector(".chat-working-indicator")).toBeNull();
    expect(
      requireElement(view.container, ".chat-group.assistant .chat-turn-recap").textContent,
    ).toContain("Done in 1 second");
  });

  it.each(["session.message", "sessions.changed"] as const)(
    "reconciles a missed earlier terminal from %s without navigating",
    async (event) => {
      const running: GatewaySessionRow = {
        key: "agent:main:resumed",
        agentId: "main",
        sessionId: "resumed-session",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["earlier-run"],
        status: "running",
      };
      const idle: GatewaySessionRow = {
        ...running,
        updatedAt: 2,
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: "resumed-run",
        status: "done",
      };
      const finalMessage = {
        role: "assistant",
        content: "Workspace cleanup is complete.",
        __openclaw: { id: "cleanup-final", seq: 1, runId: "resumed-run", runTerminal: true },
      };
      const completed: ChatHistoryResult = {
        messages: [finalMessage],
        sessionInfo: idle,
        sessionId: idle.sessionId,
      };
      const reply = createDeferred<ChatHistoryResult>();
      const historyStarted = createDeferred();
      let recovering = false;
      const history: GatewayRequestHandler = () => {
        if (recovering) {
          historyStarted.resolve();
          return reply.promise;
        }
        return {
          messages: [],
          sessionInfo: running,
          sessionId: running.sessionId,
          inFlightRun: { runId: "earlier-run", text: "Working on cleanup.", startedAt: 1 },
        };
      };
      const rows = [running];
      const { sessions, mount, emitGatewayEvent } = createMountedPanes(rows, "main", undefined, {
        "chat.history": history,
        "chat.startup": history,
      });
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(running.key);
      await refreshPane(pane);
      const state = pane.state;
      state.chatMessage = "Keep my unsent draft.";
      expect(state.chatRunId).toBe("earlier-run");
      expect(state.chatStream).toBe("Working on cleanup.");
      expect(hasAbortableSessionRun(state)).toBe(true);
      try {
        recovering = true;
        rows.splice(0, 1, idle);
        emitGatewayEvent(event, {
          sessionKey: idle.key,
          agentId: idle.agentId,
          sessionId: idle.sessionId,
          session: idle,
          clientRunId: "resumed-run",
          hasActiveRun: false,
          activeRunIds: [],
          ...(event === "session.message"
            ? { message: finalMessage, messageId: "cleanup-final", messageSeq: 1 }
            : { reason: "lifecycle" }),
        });
        const pending = getChatHistoryLoadState(state);
        expect(pending.phase).toBe("in-flight");
        if (pending.phase !== "in-flight") {
          throw new Error("Completion must automatically refresh the mounted chat");
        }
        await historyStarted.promise;
        expect(state.chatRunId).toBe("earlier-run");
        reply.resolve(completed);
        await pending.promise;
        expect(state.chatRunId).toBeNull();
        expect(state.chatStream).toBeNull();
        expect(state.chatStreamStartedAt).toBeNull();
        expect(hasAbortableSessionRun(state)).toBe(false);
        expect(state.chatMessage).toBe("Keep my unsent draft.");
        expect(state.chatMessages).toEqual([finalMessage]);
        expect(state.sessionKey).toBe(running.key);
      } finally {
        const pending = getChatHistoryLoadState(state);
        reply.resolve(completed);
        if (pending.phase === "in-flight") {
          await pending.promise;
          await pending.refresh?.promise;
        }
      }
    },
  );
});

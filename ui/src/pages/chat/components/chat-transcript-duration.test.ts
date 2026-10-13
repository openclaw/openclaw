/* @vitest-environment jsdom */
import { render, type ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatStateController } from "../chat-state-controller.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { projectChatTranscriptMetadata } from "../session-message-cache.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

describe("completed-work duration", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);
  it.each(["done", "failed", "timeout", "killed"] as const)(
    "uses matching %s lifecycle duration, not final-message creation time",
    async (status) => {
      const sessionKey = "agent:main:dashboard:duration";
      const runId = "duration-run";
      const messages = [
        {
          role: "user",
          content: "Check the report",
          timestamp: 1_000,
          __openclaw: { idempotencyKey: "duration-run:user" },
        },
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "read-report",
          content: "Report read",
          timestamp: 2_000,
          runId,
        },
        { role: "assistant", content: "Report checked", timestamp: 508_000, runId },
      ];
      const props = threadProps("pane-duration-" + status, sessionKey, messages);
      props.showToolCalls = true;
      props.selectedSession = {
        key: sessionKey,
        kind: "direct",
        status,
        lastRunId: runId,
        startedAt: 1_000,
        endedAt: 1_656_000,
        runtimeMs: 1_655_000,
        updatedAt: 1_656_000,
      };
      const liveSession = props.selectedSession;
      props.transcriptMetadata = projectChatTranscriptMetadata(liveSession);
      props.selectedSession = { key: sessionKey, kind: "direct", updatedAt: 1 };
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const rerender = () => {
        render(renderChatThread(props, transcript), container);
        transcript.hostUpdated();
      };
      try {
        // A fresh pane has never watched this run: restored lifecycle facts suffice.
        rerender();
        transcript.hostConnected();
        await flushDeferredRowPrune();
        const duration = () => container.querySelector(".chat-activity-group__label");
        expect(duration()?.textContent).toBe("Worked for 27 minutes, 35 seconds");
        props.transcriptMetadata = undefined;
        props.selectedSession = liveSession;
        props.selectedSession.runtimeMs = 1_660_000;
        rerender();
        expect(duration()?.textContent).toBe("Worked for 27 minutes, 40 seconds");
        props.messages = messages.slice(1);
        rerender();
        expect(duration()?.textContent).toBe("Worked for 27 minutes, 40 seconds");
        props.messages = messages;
        props.selectedSession.lastRunId = "unrelated-run";
        rerender();
        expect(duration()?.textContent).toBe("Worked");
        expect(container.querySelector(".chat-work-group")).not.toBeNull();
        props.selectedSession.lastRunId = runId;
        props.selectedSession.status = "running";
        rerender();
        expect(duration()?.textContent).toBe("Worked");
        props.selectedSession.status = status;
        for (const runtimeMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          props.selectedSession.runtimeMs = runtimeMs;
          rerender();
          expect(duration()?.textContent).toBe("Worked");
        }
        props.selectedSession.runtimeMs = 1_655_000;
        props.selectedSession.key = "agent:main:dashboard:other";
        rerender();
        expect(duration()?.textContent).toBe("Worked");
        expect(messages[2]?.timestamp).toBe(508_000);
      } finally {
        transcript.hostDisconnected();
        container.remove();
      }
    },
  );

  it("refreshes the work disclosure callback when its render lifecycle is replaced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    const runId = "restored-work";
    const props = threadProps("pane-redraw-owner", "agent:main:dashboard:redraw-owner", [
      {
        role: "user",
        content: "Inspect",
        timestamp: 1_000,
        __openclaw: { idempotencyKey: `${runId}:user` },
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-owner",
        content: "Read complete",
        timestamp: 2_000,
        runId,
      },
      { role: "assistant", content: "Inspection complete", timestamp: 3_000, runId },
    ]);
    props.showToolCalls = true;
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    const host: ReactiveControllerHost = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: rerender,
      updateComplete: Promise.resolve(true),
    };
    const controller = new ChatStateController(host);
    controller.hostConnected();
    const original = controller.createRenderLifecycle();
    props.onRequestUpdate = () => original.invalidate();
    try {
      rerender();
      transcript.hostConnected();
      await vi.advanceTimersByTimeAsync(0);
      const replacement = controller.createRenderLifecycle();
      props.onRequestUpdate = () => replacement.invalidate();
      rerender();
      const disclosure = container.querySelector<HTMLButtonElement>(".chat-work-group > button");
      expect(disclosure).not.toBeNull();
      expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
      disclosure?.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("read");
      disclosure?.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain("read");
      expect(container.textContent).toContain("Inspection complete");
    } finally {
      controller.hostDisconnected();
      transcript.hostDisconnected();
      container.remove();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "preserves independent and steered run ownership (steer=%s)",
    async (steer) => {
      const sessionKey = "agent:main:dashboard:boundaries";
      const prompt = (runId: string, timestamp: number, target?: string) => ({
        role: "user",
        content: "Continue " + runId,
        timestamp,
        __openclaw: {
          idempotencyKey: runId + ":user",
          ...(target ? { steerTargetRunId: target } : {}),
        },
      });
      const work = (runId: string, timestamp: number) => ({
        role: "toolResult",
        toolName: "read",
        toolCallId: runId + "-read",
        content: "Report read",
        timestamp,
        runId,
      });
      const reply = (runId: string, timestamp: number) => ({
        role: "assistant",
        content: "Finished " + runId,
        timestamp,
        runId,
      });
      const runId = steer ? "first" : "second";
      const messages = [
        prompt("first", 1_000),
        work("first", 2_000),
        ...(steer ? [] : [reply("first", 3_000)]),
        prompt("second", 4_000, steer ? "first" : undefined),
        work(runId, 5_000),
        reply(runId, 6_000),
      ];
      const props = threadProps("pane-boundaries-" + steer, sessionKey, messages);
      props.showToolCalls = true;
      props.selectedSession = {
        key: sessionKey,
        kind: "direct",
        status: "done",
        lastRunId: runId,
        runtimeMs: 20_000,
        updatedAt: 30_000,
      };
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      try {
        render(renderChatThread(props, transcript), container);
        transcript.hostConnected();
        transcript.hostUpdated();
        await flushDeferredRowPrune();
        const summaries = [...container.querySelectorAll(".chat-work-group")];
        expect(summaries).toHaveLength(steer ? 1 : 2);
        expect(
          summaries.map(
            (summary) => summary.querySelector(".chat-activity-group__label")?.textContent ?? null,
          ),
        ).toEqual(steer ? ["Worked for 20 seconds"] : ["Worked", "Worked for 20 seconds"]);
      } finally {
        transcript.hostDisconnected();
        container.remove();
      }
    },
  );
});

describe("live progress placement", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("keeps progress after accepted steers and before queued input", () => {
    const runId = "active-run";
    const prompt = (id: string, seq: number, target?: string) => ({
      role: "user",
      content: id,
      timestamp: seq * 1_000,
      __openclaw: {
        id,
        seq,
        idempotencyKey: `${id}:user`,
        ...(target ? { steerTargetRunId: target } : {}),
      },
    });
    const props = threadProps("pane-live-steer-progress", "agent:main:dashboard:progress", [
      prompt(runId, 1),
      prompt("earlier-steer", 2, runId),
      prompt("latest-steer", 3, runId),
      {
        role: "assistant",
        content: "Latest assistant update",
        timestamp: 4_000,
        __openclaw: { id: "latest-answer", seq: 4, runId },
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "latest-read",
        content: "Report read",
        timestamp: 5_000,
        runId,
        __openclaw: { id: "latest-tool", seq: 5 },
      },
    ]);
    props.showToolCalls = true;
    props.runId = runId;
    props.runActive = true;
    props.runWorking = true;
    props.streamStartedAt = 1_000;
    props.runUsageById = new Map([[runId, { outputTokens: 5_600, seq: 1 }]]);
    props.pendingInputs = [
      {
        id: "future-input",
        runId: "future-run",
        state: "queued",
        acceptedAt: 6_000,
        message: {
          role: "user",
          content: "Next queued task",
          timestamp: 6_000,
          __openclaw: { id: "pending:future-input" },
        },
      },
    ];
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    try {
      render(renderChatThread(props, transcript), container);
      transcript.hostConnected();
      transcript.hostUpdated();
      flush();
      const progress = container.querySelector(".chat-working-indicator")!;
      const answer = container.querySelector('[data-entry-id="latest-answer"]')!;
      const activity = container.querySelector('[data-entry-id="latest-tool"]')!;
      const earlierSteer = container.querySelector('[data-entry-id="earlier-steer"]')!;
      const latestSteer = container.querySelector('[data-entry-id="latest-steer"]')!;
      const future = [...container.querySelectorAll(".chat-bubble")].find((bubble) =>
        bubble.textContent?.includes("Next queued task"),
      )!;

      expect(container.querySelectorAll(".chat-working-indicator")).toHaveLength(1);
      expect(progress.textContent).toContain("5.6k output tokens");
      expect(progress.querySelector("openclaw-elapsed-time")).toMatchObject({ startMs: 1_000 });
      expect(answer.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(activity.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      for (const steer of [earlierSteer, latestSteer]) {
        expect(steer.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }
      expect(progress.compareDocumentPosition(future) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    } finally {
      transcript.hostDisconnected();
      container.remove();
    }
  });
});

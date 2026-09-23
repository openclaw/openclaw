/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
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
        const duration = () => container.querySelector(".chat-activity-group__duration");
        expect(duration()?.textContent).toBe("27m 35s");
        props.selectedSession.runtimeMs = 1_660_000;
        rerender();
        expect(duration()?.textContent).toBe("27m 40s");
        props.messages = messages.slice(1);
        rerender();
        expect(duration()?.textContent).toBe("27m 40s");
        props.messages = messages;
        props.selectedSession.lastRunId = "unrelated-run";
        rerender();
        expect(duration()).toBeNull();
        expect(container.querySelector(".chat-work-group")).not.toBeNull();
        props.selectedSession.lastRunId = runId;
        props.selectedSession.status = "running";
        rerender();
        expect(duration()).toBeNull();
        props.selectedSession.status = status;
        for (const runtimeMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          props.selectedSession.runtimeMs = runtimeMs;
          rerender();
          expect(duration()).toBeNull();
        }
        props.selectedSession.runtimeMs = 1_655_000;
        props.selectedSession.key = "agent:main:dashboard:other";
        rerender();
        expect(duration()).toBeNull();
        expect(messages[2]?.timestamp).toBe(508_000);
      } finally {
        transcript.hostDisconnected();
        container.remove();
      }
    },
  );

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
        expect(summaries).toHaveLength(2);
        expect(
          summaries.map(
            (summary) =>
              summary.querySelector(".chat-activity-group__duration")?.textContent ?? null,
          ),
        ).toEqual(steer ? ["20s", "20s"] : [null, "20s"]);
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

  it.each([false, true])(
    "keeps progress after the latest persisted steer output (older stream boundary=%s)",
    (hasOlderBoundary) => {
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
      props.streamSegments = hasOlderBoundary
        ? [{ text: "", ts: 2_000, runId, boundaryRunId: "earlier-steer", boundaryMarker: true }]
        : [];
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
        const progress = container.querySelector(".chat-working-indicator")!;
        const answer = container.querySelector('[data-entry-id="latest-answer"]')!;
        const activity = container.querySelector('[data-entry-id="latest-tool"]')!;
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
        expect(progress.compareDocumentPosition(future) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      } finally {
        transcript.hostDisconnected();
        container.remove();
      }
    },
  );
});

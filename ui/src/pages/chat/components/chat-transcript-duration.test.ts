/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { projectChatTranscriptMetadata } from "../session-message-cache.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  resetTranscriptTestDom();
});

function mount(props: ReturnType<typeof threadProps>, updateBeforeStart = true) {
  props.showToolCalls = true;
  const transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  const rerender = () => {
    render(renderChatThread(props, transcript), container);
    transcript.update();
  };
  cleanup.push(() => {
    transcript.dispose();
    container.remove();
  });
  render(renderChatThread(props, transcript), container);
  if (updateBeforeStart) {
    transcript.update();
  }
  transcript.start();
  return { container, transcript, rerender };
}

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
const reply = (runId: string, timestamp: number, content = "Finished " + runId) => ({
  role: "assistant",
  content,
  timestamp,
  runId,
});

describe("completed-work duration", () => {
  it("keeps the recap duration when zero runtime cannot label completed work", async () => {
    const sessionKey = "agent:main:dashboard:zero-runtime";
    const runId = "zero-runtime";
    const props = threadProps("pane-zero-runtime", sessionKey, [
      prompt(runId, 1_000),
      work(runId, 1_000),
    ]);
    props.runId = runId;
    props.runActive = true;
    props.runWorking = true;
    props.streamStartedAt = 1_000;
    props.runUsageById = new Map([[runId, { outputTokens: 42, seq: 1 }]]);
    const { container, rerender } = mount(props);
    props.messages = [...props.messages, reply(runId, 1_000)];
    props.runActive = false;
    props.runWorking = false;
    props.runId = null;
    props.selectedSession = {
      key: sessionKey,
      kind: "direct",
      status: "done",
      lastRunId: runId,
      runtimeMs: 0,
      updatedAt: 1_000,
    };
    rerender();
    await flushDeferredRowPrune();
    expect(container.querySelector(".chat-activity-group__label")?.textContent).toBe("Worked");
    expect(container.querySelector(".chat-turn-recap")?.textContent).toContain("Done in 1 second");
    expect(container.querySelector(".chat-turn-recap")?.textContent).toContain("42 output tokens");
  });

  it.each(["done", "failed", "timeout", "killed"] as const)(
    "uses matching %s lifecycle duration, not final-message creation time",
    async (status) => {
      const sessionKey = "agent:main:dashboard:duration";
      const runId = "duration-run";
      const messages = [prompt(runId, 1_000), work(runId, 2_000), reply(runId, 508_000)];
      const props = threadProps("pane-duration-" + status, sessionKey, messages);
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
      const { container, rerender } = mount(props);
      // A fresh pane has never watched this run: restored lifecycle facts suffice.
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
    },
  );

  it("keeps the work disclosure interactive after its parent renders again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    const runId = "restored-work";
    const props = threadProps("pane-redraw-owner", "agent:main:dashboard:redraw-owner", [
      prompt(runId, 1_000),
      work(runId, 2_000),
      reply(runId, 3_000, "Inspection complete"),
    ]);
    const { container, rerender } = mount(props);
    await vi.advanceTimersByTimeAsync(0);
    rerender();
    const disclosure = container.querySelector<HTMLButtonElement>(".chat-work-group > button");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    disclosure?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    await waitForSolid(() => expect(container.textContent).toContain("read"));
    disclosure?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("read");
    expect(container.textContent).toContain("Inspection complete");
  });

  it.each([false, true])(
    "preserves independent and steered run ownership (steer=%s)",
    async (steer) => {
      const sessionKey = "agent:main:dashboard:boundaries";
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
      props.selectedSession = {
        key: sessionKey,
        kind: "direct",
        status: "done",
        lastRunId: runId,
        runtimeMs: 20_000,
        updatedAt: 30_000,
      };
      const { container, transcript } = mount(props, false);
      transcript.update();
      await flushDeferredRowPrune();
      const summaries = [...container.querySelectorAll(".chat-work-group")];
      expect(summaries).toHaveLength(steer ? 1 : 2);
      expect(
        summaries.map(
          (summary) => summary.querySelector(".chat-activity-group__label")?.textContent ?? null,
        ),
      ).toEqual(steer ? ["Worked for 20 seconds"] : ["Worked", "Worked for 20 seconds"]);
    },
  );
});

describe("live progress placement", () => {
  it("keeps progress after accepted steers and before queued input", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(31_000);
    cleanup.push(() => clock.mockRestore());
    const runId = "active-run";
    const sequencedPrompt = (id: string, seq: number, target?: string) => ({
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
      sequencedPrompt(runId, 1),
      sequencedPrompt("earlier-steer", 2, runId),
      sequencedPrompt("latest-steer", 3, runId),
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
    const { container, transcript } = mount(props, false);
    transcript.update();
    await flushDeferredRowPrune();
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
    expect(progress.querySelector("openclaw-elapsed-time")?.textContent).toBe("30s");
    for (const preceding of [answer, activity, earlierSteer, latestSteer]) {
      expect(preceding.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
    expect(progress.compareDocumentPosition(future) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

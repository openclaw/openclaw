/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projectChatTranscriptMetadata } from "../session-message-cache.ts";
import { threadFixture } from "./chat-transcript-fixture.test-support.tsx";
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

type Props = ReturnType<typeof threadProps>;
type Session = NonNullable<Props["selectedSession"]>;
function session(runId: string, runtimeMs: number, extra: Partial<Session> = {}): Session {
  return {
    key: `agent:main:dashboard:${runId}`,
    kind: "direct",
    status: "done",
    lastRunId: runId,
    runtimeMs,
    updatedAt: 1_000,
    ...extra,
  };
}
function propsFor(runId: string, messages: unknown[]): Props {
  return threadProps(`pane-${runId}`, session(runId, 0).key, messages);
}
function running(props: Props, runId: string, outputTokens: number) {
  Object.assign(props, {
    runId,
    runActive: true,
    runWorking: true,
    streamStartedAt: 1_000,
    runUsageById: new Map([[runId, { outputTokens, seq: 1 }]]),
  });
}
function mount(props: Props, updateBeforeStart = true) {
  props.showToolCalls = true;
  const { transcript, container, rerender: draw } = threadFixture(props);
  const rerender = () => {
    draw();
    transcript.update();
  };
  cleanup.push(() => transcript.dispose());
  draw();
  if (updateBeforeStart) {
    transcript.update();
  }
  transcript.start();
  return {
    container,
    transcript,
    rerender,
    text: (selector: string) => container.querySelector(selector)?.textContent,
  };
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

it("keeps the recap duration when zero runtime cannot label completed work", async () => {
  const runId = "zero-runtime";
  const props = propsFor(runId, [prompt(runId, 1_000), work(runId, 1_000)]);
  running(props, runId, 42);
  const { text, rerender } = mount(props);
  props.messages = [...props.messages, reply(runId, 1_000)];
  props.runActive = false;
  props.runWorking = false;
  props.runId = null;
  props.selectedSession = session(runId, 0);
  rerender();
  await flushDeferredRowPrune();
  expect(text(".chat-activity-group__label")).toBe("Worked");
  expect(text(".chat-turn-recap")).toContain("Done in 1 second");
  expect(text(".chat-turn-recap")).toContain("42 output tokens");
});

it("uses matching lifecycle duration, not final-message creation time", async () => {
  const status = "done";
  const runId = "duration-run";
  const messages = [prompt(runId, 1_000), work(runId, 2_000), reply(runId, 508_000)];
  const props = propsFor(runId, messages);
  props.selectedSession = session(runId, 1_655_000, {
    status,
    startedAt: 1_000,
    endedAt: 1_656_000,
    updatedAt: 1_656_000,
  });
  const liveSession = props.selectedSession;
  props.transcriptMetadata = projectChatTranscriptMetadata(liveSession);
  props.selectedSession = { key: props.sessionKey, kind: "direct", updatedAt: 1 };
  const { container, text, rerender } = mount(props);
  // A fresh pane has never watched this run: restored lifecycle facts suffice.
  await flushDeferredRowPrune();
  const duration = () => text(".chat-activity-group__label");
  const expectDuration = (expected: string) => {
    rerender();
    expect(duration()).toBe(expected);
  };
  expect(duration()).toBe("Worked for 27 minutes, 35 seconds");
  props.transcriptMetadata = undefined;
  props.selectedSession = liveSession;
  props.selectedSession.runtimeMs = 1_660_000;
  expectDuration("Worked for 27 minutes, 40 seconds");
  props.messages = messages.slice(1);
  expectDuration("Worked for 27 minutes, 40 seconds");
  props.messages = messages;
  props.selectedSession.lastRunId = "unrelated-run";
  expectDuration("Worked");
  expect(container.querySelector(".chat-work-group")).not.toBeNull();
  props.selectedSession.lastRunId = runId;
  props.selectedSession.status = "running";
  expectDuration("Worked");
  props.selectedSession.status = status;
  for (const runtimeMs of [undefined, -1, Number.NaN]) {
    props.selectedSession.runtimeMs = runtimeMs;
    expectDuration("Worked");
  }
  props.selectedSession.runtimeMs = 1_655_000;
  props.selectedSession.key = "agent:main:dashboard:other";
  expectDuration("Worked");
});

it.each([false, true])(
  "preserves independent and steered run ownership (steer=%s)",
  async (steer) => {
    const runId = steer ? "first" : "second";
    const messages = [
      prompt("first", 1_000),
      work("first", 2_000),
      ...(steer ? [] : [reply("first", 3_000)]),
      prompt("second", 4_000, steer ? "first" : undefined),
      work(runId, 5_000),
      reply(runId, 6_000),
    ];
    const props = propsFor(runId, messages);
    props.selectedSession = session(runId, 20_000, { updatedAt: 30_000 });
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
it("keeps progress after accepted steers and before queued input", async () => {
  vi.spyOn(Date, "now").mockReturnValue(31_000);
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
  const props = propsFor(runId, [
    sequencedPrompt(runId, 1),
    sequencedPrompt("earlier-steer", 2, runId),
    sequencedPrompt("latest-steer", 3, runId),
    {
      ...reply(runId, 4_000, "Latest assistant update"),
      __openclaw: { id: "latest-answer", seq: 4, runId },
    },
    {
      ...work(runId, 5_000),
      __openclaw: { id: "latest-tool", seq: 5 },
    },
  ]);
  running(props, runId, 5_600);
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
  const future = [...container.querySelectorAll(".chat-bubble")].find((bubble) =>
    bubble.textContent?.includes("Next queued task"),
  )!;

  expect(container.querySelectorAll(".chat-working-indicator")).toHaveLength(1);
  expect(progress.textContent).toContain("5.6k output tokens");
  expect(progress.querySelector("openclaw-elapsed-time")?.textContent).toBe("30s");
  for (const id of ["latest-answer", "latest-tool", "earlier-steer", "latest-steer"]) {
    const preceding = container.querySelector(`[data-entry-id="${id}"]`)!;
    expect(preceding.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  }
  expect(progress.compareDocumentPosition(future) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

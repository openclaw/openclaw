/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
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

it("keeps a watched run's duration in its recap instead of either work stretch", async () => {
  const runId = "duration-run";
  const props = propsFor(runId, [prompt(runId, 1_000), work(runId, 2_000)]);
  running(props, runId, 42);
  const { container, text, rerender } = mount(props);
  props.messages = [
    ...props.messages,
    { ...reply(runId, 3_000, "Checking another file."), phase: "commentary" },
    { ...work(runId, 4_000), toolCallId: "second-read" },
    reply(runId, 14_000),
  ];
  props.runActive = false;
  props.runWorking = false;
  props.runId = null;
  props.selectedSession = session(runId, 13_000);
  props.transcriptMetadata = projectChatTranscriptMetadata(props.selectedSession);
  rerender();
  await flushDeferredRowPrune();
  expect(
    [...container.querySelectorAll(".chat-activity-group__label")].map(
      (label) => label.textContent,
    ),
  ).toEqual(["Worked", "Worked"]);
  expect(text(".chat-turn-recap")).toContain("Done in 13 seconds");
  expect(text(".chat-turn-recap")).toContain("42 output tokens");
});

it.each([
  [true, "live"],
  [false, "live"],
  [true, "cached"],
  [false, "cached"],
  [true, "sparse"],
  [false, "sparse"],
] as const)(
  "restores only the visible completed run's duration (matching=%s, source=%s)",
  async (matching, source) => {
    const runId = "restored-duration";
    const props = propsFor(runId, [
      prompt(runId, 1_000),
      work(runId, 2_000),
      { ...reply(runId, 3_000, "Checking another file."), phase: "commentary" },
      { ...work(runId, 4_000), toolCallId: "second-read" },
      reply(runId, 14_000),
    ]);
    const saved = session(matching ? runId : "another-run", 13_000);
    props.selectedSession =
      source === "live"
        ? saved
        : source === "sparse"
          ? { key: saved.key, kind: saved.kind, updatedAt: saved.updatedAt }
          : undefined;
    props.transcriptMetadata = source === "live" ? undefined : projectChatTranscriptMetadata(saved);
    const { container, text } = mount(props);
    await flushDeferredRowPrune();
    expect(
      [...container.querySelectorAll(".chat-activity-group__label")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["Worked", "Worked"]);
    expect(text(".chat-turn-recap") ?? "").toBe(matching ? "Done in 13 seconds" : "");
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
    ).toEqual(steer ? ["Worked"] : ["Worked", "Worked"]);
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

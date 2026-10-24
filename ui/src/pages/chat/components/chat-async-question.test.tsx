/* @vitest-environment jsdom */

import { createMemo, createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { rememberLiveTerminalRun } from "../terminal-message-identity.ts";
import { AsyncQuestionSummary } from "./chat-async-question-summary.tsx";
import {
  createAsyncQuestionPresentation,
  createAsyncQuestionPanelProps as panelProps,
  readAsyncQuestions,
  subscribeAsyncQuestionState,
} from "./chat-async-question.ts";
import type {
  AsyncQuestionDraft,
  AsyncQuestionPresentation,
  AsyncQuestions,
} from "./chat-async-question.types.ts";
import { ChatQuestionPanel } from "./chat-question-panel.tsx";

const container = document.createElement("div");
let mounted: ReturnType<typeof mountSolid> | undefined;
let updateSummary:
  | ((value: { questions: AsyncQuestions; presentation: AsyncQuestionPresentation }) => void)
  | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  updateSummary = undefined;
  container.remove();
});

function drawSummary(questions: AsyncQuestions, presentation: AsyncQuestionPresentation) {
  const next = { questions, presentation };
  if (updateSummary) {
    updateSummary(next);
  } else {
    const [current, update] = createSignal(next);
    updateSummary = update;
    mounted = mountSolid(() => <AsyncQuestionSummary {...current()} />, { container });
  }
  flush();
}

function historicalQuestion(
  itemId = "old-question",
  questions: AsyncQuestions["questions"] = [
    { title: "Which audience?", options: ["Engineers", "Everyone"] },
  ],
) {
  return { role: "assistant", openclawAsyncDelivery: { itemId, questions } };
}

function question(itemId = "question-1", runId?: string) {
  return {
    ...historicalQuestion(itemId),
    runId,
    content: "Which audience?",
    phase: "final_answer",
  };
}

function terminal(runId?: string) {
  return {
    role: "assistant",
    runId,
    phase: "final_answer",
    stopReason: "stop",
    content: "Finished the requested work.",
    __openclaw: { id: `final-${runId ?? "legacy"}`, runTerminal: true },
  };
}

function presentationState() {
  return {
    asyncQuestionDrafts: new Map<string, AsyncQuestionDraft>(),
    asyncQuestionRevision: 0,
    transcriptRenderContext: { onAsyncQuestionSubmit: vi.fn(async () => true) },
  };
}

type QuestionState = Parameters<typeof createAsyncQuestionPresentation>[0];
type PresentationOptions = Parameters<typeof createAsyncQuestionPresentation>[1];
function present(
  messages: unknown[] = [],
  state: QuestionState = presentationState(),
  options: Partial<PresentationOptions> = {},
) {
  return createAsyncQuestionPresentation(state, {
    sessionKey: "agent:main:main",
    messages,
    onAsyncQuestionSubmit: state.transcriptRenderContext.onAsyncQuestionSubmit,
    ...options,
  });
}

it("retires old reminders after a later run completes and reconstructs that outcome after reload", () => {
  const old = question("old", "run-1");
  const latest = question("latest", "run-2");
  expect(present([old, terminal("run-1")]).pending.map((entry) => entry.itemId)).toEqual(["old"]);
  const messages = [old, terminal("run-1"), latest, terminal("run-2")];
  for (const state of [presentationState(), presentationState()]) {
    const presentation = present(messages, state);
    expect(presentation.pending.map((entry) => entry.itemId)).toEqual(["latest"]);
    expect([...presentation.archived.keys()]).toEqual(["old"]);
  }
});

function expectPending(messages: unknown[], count: number, state = presentationState()) {
  expect(present(messages, state).pending).toHaveLength(count);
}

const expectText = () => expect(container.textContent);
function expectSummary(included: string[], excluded: string[] = []) {
  for (const text of included) {
    expectText().toContain(text);
  }
  for (const text of excluded) {
    expectText().not.toContain(text);
  }
}
const pendingIds = (presentation: AsyncQuestionPresentation) =>
  presentation.pending.map((entry) => entry.itemId);
const panelButton = (name: string) =>
  container.querySelector<HTMLButtonElement>(`.chat-question-panel__${name}`)!;
const user = (content: string, runId?: string) => ({ role: "user", content, runId });
const recoveryInput = (runId?: string) => ({
  ...user("Resume the interrupted work.", runId),
  provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
});
function expectTimeline(initial: unknown[], ...steps: [unknown[], number][]) {
  let messages = initial;
  for (const [appended, pending] of steps) {
    messages = messages.concat(appended);
    expectPending(messages, pending);
  }
}

it("retires a recovered run's older reminder without treating restart input as a human answer", () => {
  const recovery = recoveryInput("recovered-run");
  expectPending(
    [
      question("old", "interrupted-run"),
      { ...terminal("interrupted-run"), stopReason: "aborted" },
      recovery,
      terminal("recovered-run"),
    ],
    0,
  );
  expectPending([question(), { ...recovery, runId: undefined }, terminal()], 1);
});

it("keeps questions from overlapping runs when either run's terminal arrives last", () => {
  const messages = [question("first", "run-1"), question("second", "run-2")];
  for (const order of [
    ["run-1", "run-2"],
    ["run-2", "run-1"],
  ]) {
    expectPending([...messages, terminal(order[0])], 2);
    expectPending([...messages, ...order.map(terminal)], 2);
  }
});

it("waits for recorded origin settlement before treating another run as a successor", () => {
  expectTimeline(
    [question("old", "run-1")],
    [[terminal("run-2")], 1],
    [[terminal("run-1")], 1],
    [[terminal("run-3")], 0],
  );
});

it.each([
  { stopReason: "error" },
  { stopReason: "toolUse" },
  { phase: "commentary" },
  { openclawAbort: { aborted: true } },
  { provenance: { kind: "inter_session", sourceTool: "sessions_send" } },
  {
    openclawStreamFallback: { source: "segment", itemId: "streaming", replacementText: "Working" },
  },
  { __openclaw: { mirrorOrigin: "codex-app-server" } },
])("does not retire reminders on an unsuccessful or nonterminal reply: %j", (overrides) => {
  expectPending(
    [question("old", "run-1"), terminal("run-1"), { ...terminal("run-2"), ...overrides }],
    1,
  );
});

it("does not mistake an async final-answer item for a later run completion", () => {
  expect(
    present([
      question("old", "run-1"),
      terminal("run-1"),
      { ...question("new", "run-2"), __openclaw: { runTerminal: true } },
    ]).pending,
  ).toHaveLength(2);
});

it("requires a completed later human turn when old questions lack run identity", () => {
  const initial = [question(), terminal()];
  expectPending(initial, 1);
  expectTimeline(initial, [[user("Continue.")], 1], [[terminal()], 0]);
  expectPending(
    [
      ...initial,
      { ...user("One more constraint."), __openclaw: { steerTargetRunId: "run-1" } },
      terminal(),
    ],
    1,
  );
});

it("does not credit a late earlier-run terminal to a newer user turn for an unowned question", () => {
  expectTimeline(
    [user("First task", "run-1"), question(), user("Next task", "run-2")],
    [[terminal("run-1")], 1],
    [[terminal("run-2")], 1],
    [[user("Another task", "run-3"), terminal("run-3")], 0],
  );
});

it("retires the unowned mirrored prompt only after its canonical restart recovery succeeds", async () => {
  const old = {
    ...question("old"),
    phase: undefined,
    __openclaw: { mirrorOrigin: "codex-app-server", mirrorIdentity: "native-turn:async:old" },
  };
  const recovery = {
    ...recoveryInput(),
    __openclaw: { runId: "recovery-run", idempotencyKey: "recovery-run:user" },
  };
  const recovered = {
    role: "assistant",
    content: "The requested work is complete.",
    __openclaw: { mirrorOrigin: "codex-app-server", runId: "recovery-run", runTerminal: true },
  };
  const messages = [
    { ...user("Complete the work."), __openclaw: { runId: "original-run" } },
    old,
    {
      ...user("The connection is already available."),
      __openclaw: { runId: "reply-run", steerTargetRunId: "original-run" },
    },
    recovery,
  ];
  const state = presentationState();
  expectPending(messages, 1, state);
  expectPending([...messages, { ...recovered, stopReason: "aborted" }], 1, state);
  const completed = [...messages, recovered];
  const archived = present(completed, state);
  expect(archived.pending).toHaveLength(0);
  expectPending(completed, 0);
  expect(pendingIds(present([...messages, question("fresh", "recovery-run"), recovered]))).toEqual([
    "fresh",
  ]);
  await archived.reopen("old");
  expectPending(completed, 1, state);
  expectPending([...completed, terminal("next-run")], 0, state);
  expectPending([...messages.slice(0, -1), recovered], 1);
  expectPending(
    [
      ...messages.slice(0, -1),
      { ...recovery, provenance: { kind: "internal_system", sourceTool: "cron" } },
      recovered,
    ],
    1,
  );
  expectPending(
    [...messages, { ...recovered, __openclaw: { ...recovered["__openclaw"], runId: "other-run" } }],
    1,
  );
});

it("reopens the archived question with its draft until another later completion", () => {
  document.body.append(container);
  const old = question("old", "run-1");
  const state = presentationState();
  present([old], state);
  const draft = { answers: new Map([["0", { selected: new Set<string>(), freeText: "My team" }]]) };
  state.asyncQuestionDrafts.set("old", draft);
  const messages = [old, terminal("run-1"), terminal("run-2")];
  let presentation = present(messages, state);
  drawSummary(readAsyncQuestions(old)!, presentation);
  expectSummary(["Which audience?", "No longer pending"], ["Answer above the message box."]);
  const answer = container.querySelector<HTMLButtonElement>("button")!;
  expect(answer.textContent?.trim()).toBe("Answer");
  answer.click();
  presentation = present(messages, state);
  expect(pendingIds(presentation)).toEqual(["old"]);
  expect(state.asyncQuestionDrafts.get("old")).toBe(draft);
  expect(state.asyncQuestionDrafts.get("old")?.answers.get("0")?.freeText).toBe("My team");
  expectPending([...messages, terminal("run-3")], 0, state);
});

it("keeps a rejected in-flight answer and its retry error visible after a later completion", async () => {
  const old = question("old", "run-1");
  const state = presentationState();
  const send = createDeferred<boolean>();
  state.transcriptRenderContext.onAsyncQuestionSubmit.mockImplementation(() => send.promise);
  let messages = [old, terminal("run-1")];
  const questions = readAsyncQuestions(old)!;
  const panel = panelProps(questions, present(messages, state), {});
  const submitting = panel.onSubmit!({ "0": ["Everyone"] });
  messages = [...messages, terminal("run-2")];
  expectPending(messages, 1, state);
  send.reject(new Error("Send rejected before admission"));
  await expect(submitting).rejects.toThrow("Send rejected before admission");
  const presentation = present(messages, state);
  expect(presentation.pending).toHaveLength(1);
  expect(presentation.archived.size).toBe(0);
  const { model } = panelProps(questions, presentation, {});
  expect(model.error).toBe("Send rejected before admission");
});

it.each(["answered", "failed"] as const)(
  "keeps a remounted async question locked until its original send is %s",
  async (outcome) => {
    document.body.append(container);
    const pending = createDeferred<boolean>();
    const submit = vi.fn(() => pending.promise);
    const state = presentationState();
    state.transcriptRenderContext.onAsyncQuestionSubmit = submit;
    const questions = question().openclawAsyncDelivery;
    const draw = () => {
      mounted = mountSolid(
        () => {
          const questionState = projectSource(state, {
            read: (source) => source.asyncQuestionRevision,
            subscribe: subscribeAsyncQuestionState,
            equality: "revision",
          });
          const current = createMemo(() => {
            questionState.read();
            return present([], state);
          });
          return (
            <Show
              when={current().drafts.get(questions.itemId)?.status === "submitted"}
              fallback={<ChatQuestionPanel props={panelProps(questions, current(), {})} />}
            >
              <AsyncQuestionSummary questions={questions} presentation={current()} />
            </Show>
          );
        },
        { container },
      );
      flush();
    };
    draw();
    await waitForSolid(() => expect(panelButton("advance")).not.toBeNull());
    panelButton("advance").click();
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      "> Which audience?\n\nEngineers",
      "question-1",
      undefined,
    );

    mounted?.unmount();
    mounted = undefined;
    draw();
    await waitForSolid(() => expect(panelButton("advance")).not.toBeNull());
    expect([panelButton("advance").disabled, panelButton("skip").disabled]).toEqual([true, true]);

    if (outcome === "answered") {
      pending.resolve(true);
      await waitForSolid(() =>
        expect(container.querySelector('[role="status"]')?.textContent).toContain("Engineers"),
      );
    } else {
      pending.reject(new Error("Synthetic send failure"));
      await waitForSolid(() => expectText().toContain("Synthetic send failure"));
      expect(panelButton("advance").disabled).toBe(false);
    }
    expect(submit).toHaveBeenCalledTimes(1);
  },
);

it("does not retire reminders on an aborted live terminal projection", () => {
  const aborted = terminal("run-2");
  rememberLiveTerminalRun(aborted, "run-2", "aborted");
  expect(present([question("old", "run-1"), terminal("run-1"), aborted]).pending).toHaveLength(1);
});

it("reconsiders reminders when a message-less terminal settles a published partial", () => {
  const partial = { role: "assistant", runId: "run-1", content: "Partial work" };
  const messages = [question("old", "run-1"), partial, terminal("run-2")];
  expectPending(messages, 1);
  // Settlement changes beside, not inside, the cached history array.
  rememberLiveTerminalRun(partial, "run-1", "error");
  expectPending(messages, 0);
});

const historicalAnswer = {
  role: "user",
  content: "> Which audience?\n\nEveryone",
  __openclaw: { id: "saved-answer", seq: 2 },
};
function historyPresentation(
  messages: unknown[],
  connectionEpoch = 1,
  state: QuestionState = { ...presentationState(), transcriptRenderContext: {} },
) {
  return present(messages, state, { connectionEpoch, onAsyncQuestionSubmit: undefined });
}

it("keeps a persisted answer resolved across remount and reconnect and displays the answer", () => {
  for (const epoch of [1, 2]) {
    const presentation = historyPresentation([historicalQuestion(), historicalAnswer], epoch);
    expect(presentation.pending).toEqual([]);
    drawSummary(historicalQuestion().openclawAsyncDelivery, presentation);
    expect(container.textContent).toContain("Everyone");
  }
});

it.each([
  ["unsaved answer", [{ role: "user", content: historicalAnswer.content }], 1],
  ["unrelated text", [{ ...historicalAnswer, content: "Everyone" }], 1],
  ["internal input", [{ ...historicalAnswer, provenance: { kind: "internal_system" } }], 1],
  ["empty answer", [{ ...historicalAnswer, content: "> Which audience?\n\n" }], 1],
  [
    "new same-title question",
    [historicalAnswer, historicalQuestion("new-question")],
    ["new-question"],
  ],
  ["ambiguous duplicate", [historicalQuestion("duplicate"), historicalAnswer], 2],
] satisfies [string, unknown[], number | string[]][])(
  "resolves only the matching historical question: %s",
  (_name, replies, expected) => {
    const presentation = historyPresentation([historicalQuestion(), ...replies]);
    if (typeof expected === "number") {
      expect(presentation.pending).toHaveLength(expected);
    } else {
      expect(pendingIds(presentation)).toEqual(expected);
    }
  },
);

it("does not retain derived completion after authoritative history replaces the answer", () => {
  const state: QuestionState = { ...presentationState(), transcriptRenderContext: {} };
  expect(
    historyPresentation([historicalQuestion(), historicalAnswer], 1, state).pending,
  ).toHaveLength(0);
  expect(historyPresentation([historicalQuestion()], 1, state).pending).toHaveLength(1);
});

it("restores every answer in a multi-question submission with UTF-8-bounded quoted titles", () => {
  const promptMessage = historicalQuestion("multiple-questions", [
    { title: "界".repeat(180), options: ["One", "Two"] },
    { title: "Any\nother details?" },
  ]);
  const answer = {
    ...historicalAnswer,
    content: [
      {
        type: "text",
        text: `> ${"界".repeat(170)}\n\nTwo\n\n> Any other details?\n\nFirst line\nSecond line`,
      },
    ],
  };
  const presentation = historyPresentation([promptMessage, answer]);
  expect(presentation.pending).toHaveLength(0);
  drawSummary(promptMessage.openclawAsyncDelivery, presentation);
  expectSummary(["Two", "First line\nSecond line"]);
  expect(
    historyPresentation([
      promptMessage,
      { ...historicalAnswer, content: `> ${"界".repeat(170)}\n\nTwo` },
    ]).pending,
  ).toHaveLength(1);
});

it.each([
  { replyToId: undefined, edited: false, confirmed: false },
  { replyToId: "question-source", edited: false, confirmed: true },
  { replyToId: "question-source", edited: true, confirmed: true },
])(
  "confirms unparsed saved answers only by their canonical reply: %j",
  ({ replyToId, edited, confirmed }) => {
    const promptMessage = {
      ...historicalQuestion("ambiguous-multiline", [{ title: "First?" }, { title: "Second?" }]),
      __openclaw: { id: "question-source", seq: 1 },
    };
    const answer = {
      ...historicalAnswer,
      __openclaw: { id: "saved-answer", seq: 2, replyToId },
      content: edited
        ? "Edited in the outbox: use my earlier details."
        : "> First?\n\nQuote this:\n\n> Second?\n\nStill the first answer\n\n> Second?\n\nThe second answer",
    };
    for (const epoch of [1, 2]) {
      const presentation = historyPresentation([promptMessage, answer], epoch);
      expect(presentation.pending).toHaveLength(confirmed ? 0 : 1);
      drawSummary(promptMessage.openclawAsyncDelivery, presentation);
      expect(container.textContent?.includes("Answer sent")).toBe(confirmed);
      if (confirmed) {
        expectSummary([answer.content], ["Awaiting delivery confirmation"]);
      }
    }
  },
);

it("projects answer delivery from the outbox, retries its payload, and waits for canonical confirmation", () => {
  const state: QuestionState = presentationState();
  const retry = vi.fn();
  const queue: ChatQueueItem[] = [
    {
      id: "answer-row",
      asyncQuestionItemId: "question-1",
      text: historicalAnswer.content,
      createdAt: 1,
      sendState: "waiting-idle",
    },
  ];
  const messages: unknown[] = [historicalQuestion("question-1")];
  const props = { queue, onQueueRetry: retry, messages };
  const draw = () => {
    const presentation = present(props.messages, state, props);
    drawSummary(readAsyncQuestions(messages[0])!, presentation);
    return presentation;
  };
  const showDelivery = (sendState: ChatQueueItem["sendState"], label: string) => {
    queue[0] = { ...queue[0]!, sendState };
    draw();
    expectSummary([label]);
  };
  const pending = draw();
  const admitted = queue[0]!;
  queue.length = 0;
  expect(draw().pending).toEqual([]);
  expectSummary(["Awaiting delivery confirmation"], ["Answer sent"]);
  queue.push(admitted);
  state.asyncQuestionDrafts.set("question-1", {
    status: "submitted",
    answers: new Map([["0", { selected: new Set(), freeText: "A newer draft" }]]),
  });
  expect(pending.pending).toEqual([]);
  draw();
  expect(container.textContent).toContain("Answer queued");
  expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  queue[0] = { ...queue[0]!, sendState: "failed", sendError: "Synthetic rejection" };
  const failed = draw();
  expect(failed.historyKey).not.toBe(pending.historyKey);
  expectSummary(["Everyone", "Answer not sent", "Synthetic rejection"], ["A newer draft"]);
  container.querySelector<HTMLButtonElement>("button")!.click();
  expect(retry).toHaveBeenCalledExactlyOnceWith("answer-row");
  expect(state.transcriptRenderContext.onAsyncQuestionSubmit).not.toHaveBeenCalled();
  showDelivery("failed", "Answer not sent");
  const retainedRetry = container.querySelector<HTMLButtonElement>("button")!;
  state.asyncQuestionScope = "another-context";
  retainedRetry.click();
  expect(retry).toHaveBeenCalledTimes(1);
  state.asyncQuestionScope = failed.scope;
  showDelivery("waiting-reconnect", "Waiting for reconnect");
  expect(container.querySelector("button")).toBeNull();
  showDelivery("sending", "Sending answer");
  queue.length = 0;
  draw();
  expectSummary(["Awaiting delivery confirmation"], ["Answer sent"]);
  props.messages = [...messages, historicalAnswer];
  draw();
  expectSummary(["Answer sent", "Everyone"], ["A newer draft"]);
});

it.each(["old", "new"])(
  "uses canonical reply identity for the %s repeated-title question",
  (target) => {
    const old = {
      ...historicalQuestion("old"),
      runId: "old-run",
      __openclaw: { id: "old-source", seq: 1 },
    };
    const newest = {
      ...historicalQuestion("new"),
      runId: "new-run",
      __openclaw: { id: "new-source", seq: 3 },
    };
    const answer = {
      ...historicalAnswer,
      __openclaw: { id: "saved-answer", seq: 5, replyToId: `${target}-source` },
    };
    const presentation = historyPresentation([
      old,
      terminal("old-run"),
      newest,
      terminal("new-run"),
      answer,
    ]);
    expect([...presentation.resolved.keys()]).toEqual([target]);
    expect(presentation.resolved.get(target)?.answers.get("0")?.selected).toEqual(
      new Set(["Everyone"]),
    );
    // An archived older question remains a valid reply target; never prefer the newest title.
    if (target === "old") {
      expect(presentation.pending.map((entry) => entry.itemId)).toEqual(["new"]);
    }
  },
);

it("does not use quoted text to override a canonical reply to an unrelated message", () => {
  const promptMessage = { ...historicalQuestion(), __openclaw: { id: "question-source", seq: 1 } };
  const answer = {
    ...historicalAnswer,
    __openclaw: { id: "answer", seq: 2, replyToId: "unrelated-source" },
  };
  expect(historyPresentation([promptMessage, answer]).pending).toHaveLength(1);
});

it.each([
  { id: "generated-ui-id", __openclaw: { seq: 1 } },
  { __openclaw: { id: "unsequenced-source" } },
  { __openclaw: { id: "imported-source", seq: 1, importedFrom: "cli" } },
])("rejects noncanonical question source identities: %j", (source) => {
  expect(readAsyncQuestions({ ...question(), ...source })?.sourceMessageId).toBeUndefined();
});

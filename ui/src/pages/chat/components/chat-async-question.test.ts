/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { rememberLiveTerminalRun } from "../terminal-message-identity.ts";
import {
  createAsyncQuestionPresentation,
  createAsyncQuestionPanelProps,
  renderAsyncQuestionSummary,
  readAsyncQuestions,
} from "./chat-async-question.ts";
import type { AsyncQuestionDraft } from "./chat-async-question.types.ts";
import "./chat-question-card.ts";

const container = document.createElement("div");
afterEach(() => {
  render(nothing, container);
  container.remove();
});

function question(itemId = "question-1", runId?: string) {
  return {
    role: "assistant",
    runId,
    content: "Which audience?",
    phase: "final_answer",
    openclawAsyncDelivery: {
      itemId,
      questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
    },
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

function present(messages: unknown[], state = presentationState()) {
  return createAsyncQuestionPresentation(state, {
    sessionKey: "agent:main:main",
    messages,
    onAsyncQuestionSubmit: state.transcriptRenderContext.onAsyncQuestionSubmit,
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

it("retires a recovered run's older reminder without treating restart input as a human answer", () => {
  const recovery = {
    role: "user",
    runId: "recovered-run",
    provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
    content: "Resume the interrupted work.",
  };
  expect(
    present([
      question("old", "interrupted-run"),
      { ...terminal("interrupted-run"), stopReason: "aborted" },
      recovery,
      terminal("recovered-run"),
    ]).pending,
  ).toEqual([]);
  expect(present([question(), { ...recovery, runId: undefined }, terminal()]).pending).toHaveLength(
    1,
  );
});

it("keeps questions from overlapping runs when either run's terminal arrives last", () => {
  const messages = [question("first", "run-1"), question("second", "run-2")];
  for (const order of [
    ["run-1", "run-2"],
    ["run-2", "run-1"],
  ]) {
    expect(present([...messages, terminal(order[0])]).pending).toHaveLength(2);
    expect(present([...messages, ...order.map(terminal)]).pending).toHaveLength(2);
  }
});

it("waits for recorded origin settlement before treating another run as a successor", () => {
  const messages = [question("old", "run-1"), terminal("run-2")];
  expect(present(messages).pending).toHaveLength(1);
  messages.push(terminal("run-1"));
  expect(present(messages).pending).toHaveLength(1);
  messages.push(terminal("run-3"));
  expect(present(messages).pending).toHaveLength(0);
});

it.each([
  { stopReason: "error" },
  { stopReason: "aborted" },
  { stopReason: "cancelled" },
  { stopReason: "timeout" },
  { stopReason: "toolUse" },
  { phase: "commentary" },
  { openclawAbort: { aborted: true } },
  { provenance: { kind: "inter_session", sourceTool: "sessions_send" } },
  {
    openclawStreamFallback: { source: "segment", itemId: "streaming", replacementText: "Working" },
  },
  { __openclaw: { mirrorOrigin: "codex-app-server" } },
])("does not retire reminders on an unsuccessful or nonterminal reply: %j", (overrides) => {
  expect(
    present([question("old", "run-1"), terminal("run-1"), { ...terminal("run-2"), ...overrides }])
      .pending,
  ).toHaveLength(1);
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
  expect(present(initial).pending).toHaveLength(1);
  expect(present([...initial, { role: "user", content: "Continue." }]).pending).toHaveLength(1);
  expect(
    present([...initial, { role: "user", content: "Continue." }, terminal()]).pending,
  ).toHaveLength(0);
  expect(
    present([
      ...initial,
      { role: "user", content: "One more constraint.", __openclaw: { steerTargetRunId: "run-1" } },
      terminal(),
    ]).pending,
  ).toHaveLength(1);
});

it("does not credit a late earlier-run terminal to a newer user turn for an unowned question", () => {
  const messages = [
    { role: "user", runId: "run-1", content: "First task" },
    question(),
    { role: "user", runId: "run-2", content: "Next task" },
    terminal("run-1"),
  ];
  expect(present(messages).pending).toHaveLength(1);
  messages.push(terminal("run-2"));
  expect(present(messages).pending).toHaveLength(1);
  messages.push({ role: "user", runId: "run-3", content: "Another task" }, terminal("run-3"));
  expect(present(messages).pending).toHaveLength(0);
});

it("retires the unowned mirrored prompt only after its canonical restart recovery succeeds", async () => {
  const old = {
    ...question("old"),
    phase: undefined,
    __openclaw: { mirrorOrigin: "codex-app-server", mirrorIdentity: "native-turn:async:old" },
  };
  const recovery = {
    role: "user",
    provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
    __openclaw: { runId: "recovery-run", idempotencyKey: "recovery-run:user" },
    content: "Resume the interrupted work.",
  };
  const recovered = {
    role: "assistant",
    content: "The requested work is complete.",
    __openclaw: { mirrorOrigin: "codex-app-server", runId: "recovery-run", runTerminal: true },
  };
  const messages = [
    { role: "user", content: "Complete the work.", __openclaw: { runId: "original-run" } },
    old,
    {
      role: "user",
      content: "The connection is already available.",
      __openclaw: { runId: "reply-run", steerTargetRunId: "original-run" },
    },
    recovery,
  ];
  const state = presentationState();
  expect(present(messages, state).pending).toHaveLength(1);
  expect(
    present([...messages, { ...recovered, stopReason: "aborted" }], state).pending,
  ).toHaveLength(1);
  const completed = [...messages, recovered];
  const archived = present(completed, state);
  expect(archived.pending).toHaveLength(0);
  expect(present(completed).pending).toHaveLength(0);
  expect(
    present([...messages, question("fresh", "recovery-run"), recovered]).pending.map(
      (entry) => entry.itemId,
    ),
  ).toEqual(["fresh"]);
  await archived.reopen("old");
  expect(present(completed, state).pending).toHaveLength(1);
  expect(present([...completed, terminal("next-run")], state).pending).toHaveLength(0);
  expect(present([...messages.slice(0, -1), recovered]).pending).toHaveLength(1);
  expect(
    present([
      ...messages.slice(0, -1),
      { ...recovery, provenance: { kind: "internal_system", sourceTool: "cron" } },
      recovered,
    ]).pending,
  ).toHaveLength(1);
  expect(
    present([
      ...messages,
      { ...recovered, __openclaw: { ...recovered["__openclaw"], runId: "other-run" } },
    ]).pending,
  ).toHaveLength(1);
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
  render(renderAsyncQuestionSummary(readAsyncQuestions(old)!, presentation), container);
  expect(container.textContent).toContain("Which audience?");
  expect(container.textContent).toContain("No longer pending");
  expect(container.textContent).not.toContain("Answer above the message box.");
  const answer = container.querySelector<HTMLButtonElement>("button")!;
  expect(answer.textContent?.trim()).toBe("Answer");
  answer.click();
  presentation = present(messages, state);
  expect(presentation.pending.map((entry) => entry.itemId)).toEqual(["old"]);
  expect(state.asyncQuestionDrafts.get("old")).toBe(draft);
  expect(state.asyncQuestionDrafts.get("old")?.answers.get("0")?.freeText).toBe("My team");
  expect(present([...messages, terminal("run-3")], state).pending).toEqual([]);
});

it("keeps an in-flight submission in the dock across a later completion", () => {
  const old = question("old", "run-1");
  const state = presentationState();
  present([old], state);
  state.asyncQuestionDrafts.set("old", { answers: new Map(), status: "submitting" });
  const presentation = present([old, terminal("run-1"), terminal("run-2")], state);
  expect(presentation.pending).toHaveLength(1);
  expect(presentation.archived.size).toBe(0);
});

it("keeps a rejected in-flight answer and its retry error visible after a later completion", async () => {
  const old = question("old", "run-1");
  const state = presentationState();
  const send = createDeferred<boolean>();
  state.transcriptRenderContext.onAsyncQuestionSubmit.mockImplementation(() => send.promise);
  const messages = [old, terminal("run-1")];
  const panel = createAsyncQuestionPanelProps(
    readAsyncQuestions(old)!,
    present(messages, state),
    {},
  );
  const submitting = panel.onSubmit!({ "0": ["Everyone"] });
  messages.push(terminal("run-2"));
  expect(present(messages, state).pending).toHaveLength(1);
  send.reject(new Error("Send rejected before admission"));
  await expect(submitting).rejects.toThrow("Send rejected before admission");
  const presentation = present(messages, state);
  expect(presentation.pending).toHaveLength(1);
  expect(presentation.archived.size).toBe(0);
  expect(
    createAsyncQuestionPanelProps(readAsyncQuestions(old)!, presentation, {}).model.error,
  ).toBe("Send rejected before admission");
});

it.each(["answered", "failed"] as const)(
  "keeps a remounted async question locked until its original send is %s",
  async (outcome) => {
    document.body.append(container);
    const pending = createDeferred<boolean>();
    const submit = vi.fn(() => pending.promise);
    const state = {
      asyncQuestionDrafts: new Map<string, AsyncQuestionDraft>(),
      asyncQuestionRevision: 0,
      transcriptRenderContext: { onAsyncQuestionSubmit: submit },
    };
    const questions = {
      itemId: "question-1",
      questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
    };
    const draw = () => {
      const presentation = createAsyncQuestionPresentation(state, {
        sessionKey: "agent:main:main",
        onAsyncQuestionSubmit: submit,
        onRequestUpdate: draw,
      });
      render(
        state.asyncQuestionDrafts.get(questions.itemId)?.status === "submitted"
          ? renderAsyncQuestionSummary(questions, presentation)
          : html`<openclaw-chat-question-panel
              .props=${createAsyncQuestionPanelProps(questions, presentation, {})}
            ></openclaw-chat-question-panel>`,
        container,
      );
    };
    draw();
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-question-panel__advance")).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
    expect(submit).toHaveBeenCalledExactlyOnceWith("> Which audience?\n\nEngineers");

    render(nothing, container);
    draw();
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-question-panel__advance")).not.toBeNull(),
    );
    expect(
      container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".chat-question-panel__skip")!.disabled).toBe(
      true,
    );

    if (outcome === "answered") {
      pending.resolve(true);
      await vi.waitFor(() =>
        expect(container.querySelector('[role="status"]')?.textContent).toContain("Engineers"),
      );
    } else {
      pending.reject(new Error("Synthetic send failure"));
      await vi.waitFor(() => expect(container.textContent).toContain("Synthetic send failure"));
      expect(
        container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.disabled,
      ).toBe(false);
    }
    expect(submit).toHaveBeenCalledTimes(1);
  },
);

it("does not retire reminders on an aborted live terminal projection", () => {
  const aborted = terminal("run-2");
  rememberLiveTerminalRun(aborted, "run-2", undefined, "aborted");
  expect(present([question("old", "run-1"), terminal("run-1"), aborted]).pending).toHaveLength(1);
});

const historicalQuestion = (itemId = "old-question") => ({
  role: "assistant",
  openclawAsyncDelivery: {
    itemId,
    questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
  },
});
const historicalAnswer = {
  role: "user",
  content: "> Which audience?\n\nEveryone",
  __openclaw: { id: "saved-answer", seq: 2 },
};
function historyPresentation(messages: unknown[], connectionEpoch = 1) {
  return createAsyncQuestionPresentation(
    {
      asyncQuestionDrafts: new Map(),
      asyncQuestionRevision: 0,
      transcriptRenderContext: {},
    },
    { sessionKey: "agent:main:main", connectionEpoch, messages },
  );
}

it("keeps a persisted answer resolved across remount and reconnect and displays the answer", () => {
  for (const epoch of [1, 2]) {
    const presentation = historyPresentation([historicalQuestion(), historicalAnswer], epoch);
    expect(presentation.pending).toEqual([]);
    render(
      renderAsyncQuestionSummary(historicalQuestion().openclawAsyncDelivery, presentation),
      container,
    );
    expect(container.textContent).toContain("Everyone");
  }
});

it.each([
  { role: "user", content: historicalAnswer.content },
  { ...historicalAnswer, content: "Everyone" },
  { ...historicalAnswer, content: "An unrelated later message" },
  { ...historicalAnswer, provenance: { kind: "internal_system" } },
  { ...historicalAnswer, provenance: { kind: "inter_session" } },
  { ...historicalAnswer, content: "> Which audience?\n\n" },
])("does not treat an unsaved or unrelated reply as an answer: %j", (reply) => {
  expect(historyPresentation([historicalQuestion(), reply]).pending).toHaveLength(1);
});

it("keeps a new same-title question pending after an earlier question was answered", () => {
  expect(
    historyPresentation([
      historicalQuestion(),
      historicalAnswer,
      historicalQuestion("new-question"),
    ]).pending.map((entry) => entry.itemId),
  ).toEqual(["new-question"]);
});

it("does not guess which duplicate question an ambiguous answer belongs to", () => {
  expect(
    historyPresentation([historicalQuestion(), historicalQuestion("duplicate"), historicalAnswer])
      .pending,
  ).toHaveLength(2);
});

it("does not retain derived completion after authoritative history replaces the answer", () => {
  const state = {
    asyncQuestionDrafts: new Map<string, AsyncQuestionDraft>(),
    asyncQuestionRevision: 0,
    transcriptRenderContext: {},
  };
  const props = { sessionKey: "agent:main:main" };
  expect(
    createAsyncQuestionPresentation(state, {
      ...props,
      messages: [historicalQuestion(), historicalAnswer],
    }).pending,
  ).toHaveLength(0);
  expect(
    createAsyncQuestionPresentation(state, { ...props, messages: [historicalQuestion()] }).pending,
  ).toHaveLength(1);
});

it("restores every answer in a multi-question submission with UTF-8-bounded quoted titles", () => {
  const promptMessage = {
    role: "assistant",
    openclawAsyncDelivery: {
      itemId: "multiple-questions",
      questions: [
        { title: "界".repeat(180), options: ["One", "Two"] },
        { title: "Any\nother details?" },
      ],
    },
  };
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
  render(renderAsyncQuestionSummary(promptMessage.openclawAsyncDelivery, presentation), container);
  expect(container.textContent).toContain("Two");
  expect(container.textContent).toContain("First line\nSecond line");
  expect(
    historyPresentation([
      promptMessage,
      { ...historicalAnswer, content: `> ${"界".repeat(170)}\n\nTwo` },
    ]).pending,
  ).toHaveLength(1);
});

it("leaves an answer with ambiguous embedded question headings pending", () => {
  const promptMessage = {
    role: "assistant",
    openclawAsyncDelivery: {
      itemId: "ambiguous-multiline",
      questions: [{ title: "First?" }, { title: "Second?" }],
    },
  };
  const answer = {
    ...historicalAnswer,
    content:
      "> First?\n\nQuote this:\n\n> Second?\n\nStill the first answer\n\n> Second?\n\nThe second answer",
  };
  expect(historyPresentation([promptMessage, answer]).pending).toHaveLength(1);
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

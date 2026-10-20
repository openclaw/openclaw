/* @vitest-environment jsdom */

import { createComponent, createRoot, createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createComposerProps, resetComposerFixture } from "./chat-composer.test-support.ts";
import { createAsyncQuestionPresentation } from "./components/chat-async-question.ts";
import { createComposerQuestionPanel } from "./components/chat-composer-question.tsx";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { ChatQuestionPanel } from "./components/chat-question-panel.tsx";

afterEach(() => resetComposerFixture());

function questionReader(props: ReturnType<typeof createComposerProps>) {
  return createRoot((dispose) => {
    onTestFinished(dispose);
    const [current, refresh] = createSignal(props, { equals: false });
    const panel = createComposerQuestionPanel(current, getChatComposerState(props.paneId));
    return () => {
      refresh(props);
      flush();
      return panel();
    };
  });
}

function optionalQuestion(draft = "Keep writing", withOptions = true) {
  const textarea = document.body.appendChild(document.createElement("textarea"));
  const props = createComposerProps({ draft });
  getChatComposerState(props.paneId).composerTextarea = textarea;
  props.asyncQuestions = createAsyncQuestionPresentation(
    { asyncQuestionDrafts: new Map(), asyncQuestionRevision: 0, transcriptRenderContext: {} },
    {
      sessionKey: props.sessionKey,
      onAsyncQuestionSubmit: async () => true,
      messages: [
        {
          role: "assistant",
          content: "Which audience?",
          openclawAsyncDelivery: {
            itemId: "audience",
            questions: [
              {
                title: "Which audience?",
                ...(withOptions ? { options: ["Everyone", "Engineers"] } : {}),
              },
            ],
          },
        },
      ],
    },
  );
  return { textarea, props, questions: props.asyncQuestions };
}

it.each(["draft", "focus"])(
  "keeps a new optional question compact around existing composer %s without closing an explicit expansion",
  async (editing) => {
    const { textarea, props, questions } = optionalQuestion(
      editing === "draft" ? "Keep writing" : "",
    );
    if (editing === "focus") {
      textarea.focus();
    }
    // The persistence adapter can initialize an untouched draft before the dock renders.
    questions.drafts.set("audience", {
      answers: new Map([["0", { selected: new Set(["Everyone"]), freeText: "" }]]),
    });
    const readPanel = questionReader(props);
    let panel = readPanel()!;
    expect(panel.model).toMatchObject({ nonBlocking: true, collapsed: true, autoFocus: false });
    const container = document.createElement("div");
    document.body.append(container);
    const view = mountSolid(() => createComponent(ChatQuestionPanel, { props: panel }), {
      container,
    });
    onTestFinished(view.unmount);
    await container.querySelector<ChatQuestionPanel>("openclaw-chat-question-panel")
      ?.updateComplete;
    expect(container.textContent).not.toContain("Optional · work can continue");
    expect(container.textContent).toContain("1 unanswered question");
    if (editing === "focus") {
      expect(document.activeElement).toBe(textarea);
    }

    // Durability becoming ready or a reconnect changes the callback scope, not
    // the operator's disclosure choice for this still-pending question.
    questions.scope += ":owner-ready";
    panel = readPanel()!;
    expect(panel.model.collapsed).toBe(true);
    if (editing === "focus") {
      expect(document.activeElement).toBe(textarea);
    }

    const submit = questions.submit;
    questions.submit = undefined;
    expect(readPanel()).toBeNull();
    questions.scope += ":reconnected";
    questions.submit = submit;
    panel = readPanel()!;
    expect(panel.model.collapsed).toBe(true);

    panel.onCollapsedChange?.(false);
    panel = readPanel()!;
    expect(panel.model.collapsed).toBe(false);
    textarea.focus();
    questions.scope += ":reconnected";
    expect(readPanel()!.model.collapsed).toBe(false);

    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    panel.onCollapsedChange?.(true);
    await Promise.resolve();
    expect(document.activeElement).toBe(textarea);
  },
);

it("keeps an unseen queued optional question compact when the previous request leaves", () => {
  const { textarea, props, questions } = optionalQuestion("Keep writing", false);
  textarea.focus();
  const readPanel = questionReader(props);
  expect(readPanel()!.model.collapsed).toBe(true);

  questions.pending.push({
    itemId: "format",
    questions: [{ title: "Which format?" }],
  });
  let panel = readPanel()!;
  expect(panel.model.questions[0]?.question).toBe("Which audience?");
  expect(panel.model.collapsed).toBe(true);

  questions.pending.shift();
  panel = readPanel()!;
  expect(panel.model.questions[0]?.question).toBe("Which format?");
  expect(panel.model.collapsed).toBe(true);
  expect(document.activeElement).toBe(textarea);

  // Explicit navigation is an intentional expansion, not an automatic arrival.
  questions.pending.push({
    itemId: "tone",
    questions: [{ title: "Which tone?" }],
  });
  readPanel()!.onNextRequest?.();
  panel = readPanel()!;
  expect(panel.model.questions[0]?.question).toBe("Which tone?");
  expect(panel.model.collapsed).toBe(false);
});

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
const question = (itemId: string, options?: string[]) => ({
  itemId,
  questions: [{ title: `Which ${itemId}?`, ...(options ? { options } : {}) }],
});
function questionReader(props: ReturnType<typeof createComposerProps>) {
  return createRoot((dispose) => {
    onTestFinished(dispose);
    const [current, refresh] = createSignal(props, { equals: false });
    const panel = createComposerQuestionPanel(current, getChatComposerState(props.paneId));
    return (collapsed?: boolean, text?: string) => {
      refresh(props);
      flush();
      const value = panel();
      if (collapsed !== undefined) {
        expect(value?.model.collapsed).toBe(collapsed);
      }
      if (text) {
        expect(value?.model.questions[0]?.question).toBe(text);
      }
      return value;
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
          openclawAsyncDelivery: question(
            "audience",
            withOptions ? ["Everyone", "Engineers"] : undefined,
          ),
        },
      ],
    },
  );
  return { textarea, props, questions: props.asyncQuestions };
}

it.each(["draft", "focus"])(
  "keeps optional questions compact while editing via %s",
  async (editing) => {
    const { textarea, props, questions } = optionalQuestion(
      editing === "draft" ? "Keep writing" : "",
    );
    if (editing === "focus") {
      textarea.focus();
    }
    // Persistence can initialize an untouched draft before the dock renders.
    questions.drafts.set("audience", {
      answers: new Map([["0", { selected: new Set(["Everyone"]), freeText: "" }]]),
    });
    const readPanel = questionReader(props);
    let panel = readPanel(true)!;
    expect(panel.model).toMatchObject({ nonBlocking: true, autoFocus: false });
    const container = document.body.appendChild(document.createElement("div"));
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

    // Owner readiness/reconnect must not reset the operator's disclosure choice.
    questions.scope += ":owner-ready";
    readPanel(true);
    if (editing === "focus") {
      expect(document.activeElement).toBe(textarea);
    }
    const submit = questions.submit;
    questions.submit = undefined;
    expect(readPanel()).toBeNull();
    questions.scope += ":reconnected";
    questions.submit = submit;
    panel = readPanel(true)!;
    panel.onCollapsedChange?.(false);
    panel = readPanel(false)!;
    textarea.focus();
    questions.scope += ":reconnected";
    readPanel(false);
    document.body.appendChild(document.createElement("button")).focus();
    panel.onCollapsedChange?.(true);
    await Promise.resolve();
    expect(document.activeElement).toBe(textarea);
  },
);

it("keeps unseen queued questions compact but expands explicit navigation", () => {
  const { textarea, props, questions } = optionalQuestion("Keep writing", false);
  textarea.focus();
  const readPanel = questionReader(props);
  readPanel(true);
  questions.pending.push(question("format"));
  readPanel(true, "Which audience?");
  questions.pending.shift();
  readPanel(true, "Which format?");
  expect(document.activeElement).toBe(textarea);
  questions.pending.push(question("tone"));
  readPanel()!.onNextRequest?.();
  readPanel(false, "Which tone?");
});

/* @vitest-environment jsdom */
import { createComponent, createRoot, createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createComposerProps, resetComposerFixture } from "./chat-composer.test-support.ts";
import { createComposerQuestionPanel } from "./components/chat-composer-question.tsx";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { ChatQuestionPanel } from "./components/chat-question-panel.tsx";

afterEach(() => resetComposerFixture());
const question = (itemId: string, options?: string[]) => ({
  itemId,
  questions: [{ title: `Which ${itemId}?`, ...(options ? { options } : {}) }],
});
type QuestionProps = ReturnType<typeof createComposerProps> & {
  onAsyncQuestionSubmit?: () => Promise<boolean>;
};
function questionReader(props: QuestionProps) {
  return createRoot((dispose) => {
    onTestFinished(dispose);
    const [current, refresh] = createSignal(props, { equals: false });
    const questions = createComposerQuestions(props.paneId, current);
    const panel = createComposerQuestionPanel(() => questions);
    const read = (collapsed?: boolean, text?: string) => {
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
    return Object.assign(read, { questions: () => questions.source()!.asyncQuestions });
  });
}
function optionalQuestion(draft = "Keep writing", withOptions = true) {
  const textarea = document.body.appendChild(document.createElement("textarea"));
  const props: QuestionProps = {
    ...createComposerProps({
      draft,
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
    }),
    onAsyncQuestionSubmit: async () => true,
  };
  getChatComposerState(props.paneId).composerTextarea = textarea;
  return { textarea, props };
}

it.each(["draft", "focus"])(
  "keeps optional questions compact while editing via %s",
  async (editing) => {
    const { textarea, props } = optionalQuestion(editing === "draft" ? "Keep writing" : "");
    if (editing === "focus") {
      textarea.focus();
    }
    // Persistence can initialize an untouched draft before the dock renders.
    const readPanel = questionReader(props);
    readPanel.questions().drafts.set("audience", {
      answers: new Map([["0", { selected: new Set(["Everyone"]), freeText: "" }]]),
    });
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
    props.connectionEpoch = 1;
    readPanel(true);
    if (editing === "focus") {
      expect(document.activeElement).toBe(textarea);
    }
    const submit = props.onAsyncQuestionSubmit;
    props.onAsyncQuestionSubmit = undefined;
    expect(readPanel()).toBeNull();
    props.connectionEpoch = 2;
    props.onAsyncQuestionSubmit = submit;
    panel = readPanel(true)!;
    panel.onCollapsedChange?.(false);
    panel = readPanel(false)!;
    textarea.focus();
    props.connectionEpoch = 3;
    readPanel(false);
    document.body.appendChild(document.createElement("button")).focus();
    panel.onCollapsedChange?.(true);
    await Promise.resolve();
    expect(document.activeElement).toBe(textarea);
  },
);

it("keeps unseen queued questions compact but expands explicit navigation", () => {
  const { textarea, props } = optionalQuestion("Keep writing", false);
  textarea.focus();
  const readPanel = questionReader(props);
  readPanel(true);
  props.messages = [
    ...props.messages,
    { role: "assistant", openclawAsyncDelivery: question("format") },
  ];
  readPanel(true, "Which audience?");
  props.messages = props.messages.slice(1);
  readPanel(true, "Which format?");
  expect(document.activeElement).toBe(textarea);
  props.messages = [
    ...props.messages,
    { role: "assistant", openclawAsyncDelivery: question("tone") },
  ];
  readPanel()!.onNextRequest?.();
  readPanel(false, "Which tone?");
});

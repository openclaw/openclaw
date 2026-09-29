/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createComposerProps, resetComposerFixture } from "./chat-composer.test-support.ts";
import { createAsyncQuestionPresentation } from "./components/chat-async-question.ts";
import { resolveComposerQuestionPanel } from "./components/chat-composer-question.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import "./components/chat-question-card.ts";

afterEach(() => resetComposerFixture());

it.each(["draft", "focus"])(
  "keeps a new optional question compact around existing composer %s without closing an explicit expansion",
  async (editing) => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const props = createComposerProps({ draft: editing === "draft" ? "Keep writing" : "" });
    const state = getChatComposerState(props.paneId);
    state.composerTextarea = textarea;
    if (editing === "focus") {
      textarea.focus();
    }
    props.asyncQuestions = createAsyncQuestionPresentation(
      {
        asyncQuestionDrafts: new Map(),
        asyncQuestionRevision: 0,
        transcriptRenderContext: {},
      },
      {
        sessionKey: props.sessionKey,
        onAsyncQuestionSubmit: async () => true,
        messages: [
          {
            role: "assistant",
            content: "Which audience?",
            openclawAsyncDelivery: {
              itemId: "audience",
              questions: [{ title: "Which audience?", options: ["Everyone", "Engineers"] }],
            },
          },
        ],
      },
    );
    // The persistence adapter can initialize an untouched draft before the dock renders.
    props.asyncQuestions.drafts.set("audience", {
      answers: new Map([["0", { selected: new Set(["Everyone"]), freeText: "" }]]),
    });
    const requestUpdate = vi.fn();
    let panel = resolveComposerQuestionPanel(props, state, requestUpdate)!;
    expect(panel.model.nonBlocking).toBe(true);
    expect(panel.model.collapsed).toBe(true);
    expect(panel.model.autoFocus).toBe(false);
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`<openclaw-chat-question-panel .props=${panel}></openclaw-chat-question-panel>`,
      container,
    );
    await (container.firstElementChild as HTMLElement & { updateComplete: Promise<unknown> })
      .updateComplete;
    expect(container.textContent).toContain("Optional · work can continue");
    expect(container.textContent).toContain("1 unanswered question");
    if (editing === "focus") {
      expect(document.activeElement).toBe(textarea);
    }

    // Durability becoming ready or a reconnect changes the callback scope, not
    // the operator's disclosure choice for this still-pending question.
    props.asyncQuestions.scope = `${props.asyncQuestions.scope}:owner-ready`;
    panel = resolveComposerQuestionPanel(props, state, requestUpdate)!;
    expect(panel.model.collapsed).toBe(true);
    if (editing === "focus") {
      expect(document.activeElement).toBe(textarea);
    }

    const submit = props.asyncQuestions.submit;
    props.asyncQuestions.submit = undefined;
    expect(resolveComposerQuestionPanel(props, state, requestUpdate)).toBeNull();
    props.asyncQuestions.scope = `${props.asyncQuestions.scope}:reconnected`;
    props.asyncQuestions.submit = submit;
    panel = resolveComposerQuestionPanel(props, state, requestUpdate)!;
    expect(panel.model.collapsed).toBe(true);

    panel.onCollapsedChange?.(false);
    panel = resolveComposerQuestionPanel(props, state, requestUpdate)!;
    expect(panel.model.collapsed).toBe(false);
    textarea.focus();
    props.asyncQuestions.scope = `${props.asyncQuestions.scope}:reconnected`;
    expect(resolveComposerQuestionPanel(props, state, requestUpdate)!.model.collapsed).toBe(false);

    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    panel.onCollapsedChange?.(true);
    await Promise.resolve();
    expect(document.activeElement).toBe(textarea);
  },
);

it("keeps an unseen queued optional question compact when the previous request leaves", () => {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  textarea.focus();
  const props = createComposerProps({ draft: "Keep writing" });
  const state = getChatComposerState(props.paneId);
  state.composerTextarea = textarea;
  props.asyncQuestions = createAsyncQuestionPresentation(
    {
      asyncQuestionDrafts: new Map(),
      asyncQuestionRevision: 0,
      transcriptRenderContext: {},
    },
    {
      sessionKey: props.sessionKey,
      onAsyncQuestionSubmit: async () => true,
      messages: [
        {
          role: "assistant",
          content: "Which audience?",
          openclawAsyncDelivery: {
            itemId: "audience",
            questions: [{ title: "Which audience?" }],
          },
        },
      ],
    },
  );
  const requestUpdate = vi.fn();
  expect(resolveComposerQuestionPanel(props, state, requestUpdate)!.model.collapsed).toBe(true);

  props.asyncQuestions.pending.push({
    itemId: "format",
    questions: [{ title: "Which format?" }],
  });
  let panel = resolveComposerQuestionPanel(props, state, requestUpdate)!;
  expect(panel.model.questions[0]?.question).toBe("Which audience?");
  expect(panel.model.collapsed).toBe(true);

  props.asyncQuestions.pending.shift();
  panel = resolveComposerQuestionPanel(props, state, requestUpdate)!;
  expect(panel.model.questions[0]?.question).toBe("Which format?");
  expect(panel.model.collapsed).toBe(true);
  expect(document.activeElement).toBe(textarea);

  // Explicit navigation is an intentional expansion, not an automatic arrival.
  props.asyncQuestions.pending.push({
    itemId: "tone",
    questions: [{ title: "Which tone?" }],
  });
  resolveComposerQuestionPanel(props, state, requestUpdate)!.onNextRequest?.();
  panel = resolveComposerQuestionPanel(props, state, requestUpdate)!;
  expect(panel.model.questions[0]?.question).toBe("Which tone?");
  expect(panel.model.collapsed).toBe(false);
});

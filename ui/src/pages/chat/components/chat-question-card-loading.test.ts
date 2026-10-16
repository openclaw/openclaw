/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { ensureCustomElementDefined } from "../../../app/lazy-custom-element.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ComposerQuestionDock } from "./chat-composer-question.tsx";
import { questionPanelIn } from "./chat-question-card.test-support.ts";
import type { ChatQuestionCard, QuestionPanelProps } from "./chat-question-card.ts";

const mountedViews: ReturnType<typeof mountSolid>[] = [];

afterEach(() => {
  for (const view of mountedViews) {
    view.unmount();
  }
  mountedViews.length = 0;
  document.body.replaceChildren();
  vi.doUnmock("./chat-question-panel.tsx");
  vi.restoreAllMocks();
});

it("defers the question controls, retries failed loading, and mounts only the current connected request", async () => {
  const initialLoad = createDeferred();
  const retryLoad = createDeferred();
  const loadStarted = createDeferred();
  const load = vi
    .fn<() => Promise<void>>()
    .mockReturnValueOnce(initialLoad.promise)
    .mockReturnValueOnce(retryLoad.promise);
  vi.doMock(import("./chat-question-panel.tsx"), async (importOriginal) => {
    const pending = load();
    loadStarted.resolve();
    await pending;
    return importOriginal();
  });
  const container = document.body.appendChild(document.createElement("div"));
  let updatePanel!: (value: QuestionPanelProps | null) => void;
  const currentView = mountSolid(
    () => {
      const [panel, setPanel] = createSignal<QuestionPanelProps | null>(null);
      updatePanel = setPanel;
      return createComponent(ComposerQuestionDock, {
        get panel() {
          return panel();
        },
      });
    },
    { container },
  );
  mountedViews.push(currentView);
  flush();
  expect(customElements.get("openclaw-chat-question-panel")).toBeUndefined();
  expect(load).not.toHaveBeenCalled();

  const onSubmit = vi.fn();
  const props: QuestionPanelProps = {
    model: {
      requestKey: "old-request",
      title: "Question",
      questions: [
        { questionId: "answer", header: "Answer", question: "Old question", options: [] },
      ],
      collapsed: false,
      disabled: false,
      drafts: new Map(),
    },
    onSubmit,
  };
  updatePanel(props);
  flush();
  const card = container.querySelector<ChatQuestionCard>("openclaw-chat-question-card")!;
  await card.updateComplete;
  await loadStarted.promise;
  expect(card.querySelector('[role="status"]')).not.toBeNull();
  expect(card.querySelector("openclaw-chat-question-panel")).toBeNull();
  const loadError = new Error("Synthetic load failure");
  const failed = expect(
    ensureCustomElementDefined("openclaw-chat-question-panel", async () => {
      throw new Error("Expected the question card to start loading its panel");
    }),
  ).rejects.toMatchObject({ cause: loadError });
  initialLoad.reject(loadError);
  await failed;
  await card.updateComplete;
  expect(card.querySelector('[role="alert"]')?.textContent).toContain("Synthetic load failure");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledOnce();

  card.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await card.updateComplete;
  expect(card.querySelector('[role="status"]')).not.toBeNull();
  const current: QuestionPanelProps = {
    ...props,
    model: {
      ...props.model,
      requestKey: "current-request",
      questions: [
        {
          questionId: "answer",
          header: "Answer",
          question: "Current question",
          options: [],
          presentation: "form",
          defaultAnswers: ["  current value  "],
        },
      ],
      drafts: new Map(),
    },
  };
  updatePanel(current);
  flush();
  await card.updateComplete;
  const removed = document.body.appendChild(document.createElement("div"));
  const removedView = mountSolid(() => createComponent(ComposerQuestionDock, { panel: props }), {
    container: removed,
  });
  mountedViews.push(removedView);
  flush();
  const removedCard = removed.querySelector<ChatQuestionCard>("openclaw-chat-question-card")!;
  await removedCard.updateComplete;
  removed.remove();

  retryLoad.resolve();
  const panel = await questionPanelIn(container);
  expect(load).toHaveBeenCalledTimes(2);
  expect(card.textContent).toContain("Current question");
  expect(card.textContent).not.toContain("Old question");
  expect(removedCard.querySelector(".chat-question-panel")).toBeNull();
  expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));
  expect(props.model.drafts.size).toBe(0);
  expect(card.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("  current value  ");
  card.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ answer: ["  current value  "] });

  document.body.append(removed);
  await questionPanelIn(removed);
  expect(removedCard.textContent).toContain("Old question");
  expect(load).toHaveBeenCalledTimes(2);
});

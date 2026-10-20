/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { ensureCustomElementDefined } from "../../../app/lazy-custom-element.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ComposerQuestionDock } from "./chat-composer-question.tsx";
import { questionPanelIn } from "./chat-question-card.test-support.ts";
import type { ChatQuestionCard, QuestionPanelProps } from "./chat-question-card.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.doUnmock("./chat-question-panel.tsx");
  vi.restoreAllMocks();
});

function model(key: string, text: string, defaults?: string[]): QuestionPanelProps["model"] {
  return {
    requestKey: key,
    title: "Question",
    questions: [
      {
        questionId: "answer",
        header: "Answer",
        question: text,
        options: [],
        ...(defaults ? { presentation: "form" as const, defaultAnswers: defaults } : {}),
      },
    ],
    collapsed: false,
    disabled: false,
    drafts: new Map(),
  };
}
function mountDock(initial: QuestionPanelProps | null = null) {
  const container = document.body.appendChild(document.createElement("div"));
  let updatePanel!: (value: QuestionPanelProps | null) => void;
  mountSolid(
    () => {
      const [panel, setPanel] = createSignal(initial);
      updatePanel = setPanel;
      return createComponent(ComposerQuestionDock, {
        get panel() {
          return panel();
        },
      });
    },
    { container },
  );
  flush();
  return { container, updatePanel };
}

it("defers controls, retries loading, and mounts only the current connected request", async () => {
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
  const { container, updatePanel } = mountDock();
  expect(customElements.get("openclaw-chat-question-panel")).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
  const onSubmit = vi.fn();
  const props = { model: model("old-request", "Old question"), onSubmit };
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
  updatePanel({
    model: model("current-request", "Current question", ["  current value  "]),
    onSubmit,
  });
  flush();
  await card.updateComplete;
  const { container: removed } = mountDock(props);
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

/* @vitest-environment jsdom */
import assert from "node:assert/strict";
import { expect, it, onTestFinished, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { focusChatComposerFromPrintableKeydown } from "../chat-pane-shared.ts";
import { ChatQuestionPanel } from "./chat-question-panel.tsx";
import type { QuestionPanelProps } from "./chat-question-types.ts";

async function mountQuestion() {
  const root = document.body.appendChild(document.createElement("div"));
  const composer = root.appendChild(document.createElement("textarea"));
  composer.value = "kept draft";
  const panel = root.appendChild(new ChatQuestionPanel.Element());
  const onSubmit = vi.fn();
  const props: QuestionPanelProps = {
    model: {
      requestKey: "optional-keyboard",
      title: "Choose a format",
      collapsed: true,
      autoFocus: false,
      nonBlocking: true,
      disabled: false,
      questions: [
        {
          questionId: "format",
          header: "Format",
          question: "Which format?",
          isOther: true,
          options: [{ label: "Compact" }, { label: "Detailed" }],
        },
      ],
      drafts: new Map([["format", { selected: new Set(["Compact"]), freeText: "" }]]),
    },
    onSubmit,
  };
  const capture = (event: KeyboardEvent) =>
    focusChatComposerFromPrintableKeydown(root, event, composer);
  document.addEventListener("keydown", capture, true);
  onTestFinished(() => {
    document.removeEventListener("keydown", capture, true);
    root.remove();
  });
  panel.props = props;
  await panel.updateComplete;
  composer.focus();
  panel.querySelector<HTMLButtonElement>(".chat-question-panel__collapsed-button")!.click();
  await panel.updateComplete;
  const group = panel.querySelector<HTMLElement>("section.chat-question-panel")!;
  assert(group.isConnected);
  expect(document.activeElement).toBe(group);
  expect(composer.disabled || composer.readOnly).toBe(false);
  return { root, panel, group, composer, props, onSubmit };
}

function press(target: HTMLElement, key: string) {
  target.focus();
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  return event;
}

it.each(["group", "option"])("keeps answer key 2 at the focused %s", async (focus) => {
  const { panel, group, composer, props } = await mountQuestion();
  const target =
    focus === "group" ? group : panel.querySelector<HTMLButtonElement>("[data-option-index='0']")!;
  const event = press(target, "2");
  await panel.updateComplete;
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Detailed"]);
  expect(document.activeElement).toBe(target);
  expect(event.defaultPrevented).toBe(true);
  expect(composer.value).toBe("kept draft");
});

it("keeps Other key 3 at the expanded question", async () => {
  const { panel, group, composer } = await mountQuestion();
  const event = press(group, "3");
  await panel.updateComplete;
  expect(document.activeElement).toBe(panel.querySelector("textarea"));
  expect(event.defaultPrevented).toBe(true);
  expect(composer.value).toBe("kept draft");
});

it.each(["disabled", "submitting"] as const)(
  "does not claim disabled answer or Other keys while %s",
  async (flag) => {
    const { panel, group, composer, props } = await mountQuestion();
    panel.props = { ...props, model: { ...props.model, [flag]: true } };
    await panel.updateComplete;
    for (const key of ["2", "3"]) {
      const event = press(group, key);
      expect(document.activeElement).toBe(composer);
      expect(event.defaultPrevented).toBe(false);
    }
    expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
  },
);

it.each(["a", "A", "0", "9"])("keeps composer typing for unadvertised key %s", async (key) => {
  const { group, composer, props } = await mountQuestion();
  const event = press(group, key);
  expect(document.activeElement).toBe(composer);
  expect(event.defaultPrevented).toBe(false);
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
});

it("does not reinterpret a numeric key while editing Other", async () => {
  const { panel, composer, props } = await mountQuestion();
  const input = panel.querySelector<HTMLTextAreaElement>("textarea")!;
  const event = press(input, "2");
  expect(document.activeElement).toBe(input);
  expect(event.defaultPrevented).toBe(false);
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
  expect(composer.value).toBe("kept draft");
});

it("does not let another question claim an unrelated control's key", async () => {
  const { root, composer } = await mountQuestion();
  const outside = root.appendChild(document.createElement("button"));
  press(outside, "2");
  expect(document.activeElement).toBe(composer);
});

it("routes numeric typing on a question link to the composer", async () => {
  const { panel, composer, props } = await mountQuestion();
  panel.props = {
    ...props,
    model: {
      ...props.model,
      questions: [{ ...props.model.questions[0]!, url: "https://example.test/confirm" }],
    },
  };
  await panel.updateComplete;
  const link = panel.querySelector<HTMLAnchorElement>("a[href]")!;
  const event = press(link, "2");
  expect(document.activeElement).toBe(composer);
  expect(event.defaultPrevented).toBe(false);
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
});

it("restores collapse-button focus and stops claiming collapsed shortcuts", async () => {
  const { panel, composer } = await mountQuestion();
  panel.querySelector<HTMLButtonElement>(".chat-question-panel__collapse")!.click();
  await panel.updateComplete;
  const collapsed = panel.querySelector<HTMLButtonElement>(
    ".chat-question-panel__collapsed-button",
  )!;
  expect(document.activeElement).toBe(collapsed);
  press(collapsed, "2");
  expect(document.activeElement).toBe(composer);
});

it("yields answer and Other ownership while submission is pending", async () => {
  const { panel, group, composer, props } = await mountQuestion();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  panel.props = { ...props, onSubmit: () => pending };
  await panel.updateComplete;
  panel.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
  await panel.updateComplete;
  await waitForSolid(() =>
    expect(panel.querySelector<HTMLButtonElement>("[data-option-index='1']")!.disabled).toBe(true),
  );
  for (const key of ["2", "3"]) {
    press(group, key);
    expect(document.activeElement).toBe(composer);
  }
  finish();
  await pending;
  await panel.updateComplete;
});

it("claims only displayed digits when there are more than nine options", async () => {
  const { panel, group, composer, props } = await mountQuestion();
  panel.props = {
    ...props,
    model: {
      ...props.model,
      questions: [
        {
          ...props.model.questions[0]!,
          options: Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index + 1}` })),
        },
      ],
    },
  };
  await panel.updateComplete;
  press(group, "9");
  await panel.updateComplete;
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Option 9"]);
  press(group, "0");
  expect(document.activeElement).toBe(composer);
  expect(panel.querySelectorAll("[data-shortcut]")).toHaveLength(9);
});

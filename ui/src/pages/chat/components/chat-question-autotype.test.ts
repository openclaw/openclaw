/* @vitest-environment jsdom */
import assert from "node:assert/strict";
import { expect, it, onTestFinished, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { focusChatComposerFromKeydown } from "../chat-pane-shared.ts";
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
  const capture = (event: KeyboardEvent) => focusChatComposerFromKeydown(root, event, composer);
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
  const update = async (model: Partial<QuestionPanelProps["model"]>) => {
    panel.props = { ...props, model: { ...props.model, ...model } };
    await panel.updateComplete;
  };
  return { root, panel, group, composer, props, onSubmit, update };
}
const button = (panel: Element, name: string) =>
  panel.querySelector<HTMLButtonElement>(`.chat-question-panel__${name}`)!;
function expectDraft(props: QuestionPanelProps, ...selected: string[]) {
  expect([...props.model.drafts.get("format")!.selected]).toEqual(selected);
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

it.each([
  ["group", "2", "Detailed"],
  ["option", "2", "Detailed"],
  ["group", "3", "Compact"],
])("keeps advertised key %s/%s in the question", async (focus, key, selected) => {
  const { panel, group, composer, props } = await mountQuestion();
  const target =
    focus === "group" ? group : panel.querySelector<HTMLElement>("[data-option-index='0']")!;
  const event = press(target, key);
  await panel.updateComplete;
  expectDraft(props, selected);
  expect(document.activeElement).toBe(key === "3" ? panel.querySelector("textarea") : target);
  expect(event.defaultPrevented).toBe(true);
  expect(composer.value).toBe("kept draft");
});

it.each(["disabled", "submitting"] as const)("yields disabled shortcuts while %s", async (flag) => {
  const { group, composer, props, update } = await mountQuestion();
  await update({ [flag]: true });
  for (const key of ["2", "3"]) {
    const event = press(group, key);
    expect(document.activeElement).toBe(composer);
    expect(event.defaultPrevented).toBe(false);
  }
  expectDraft(props, "Compact");
});

it.each([
  ["group", "a"],
  ["group", "0"],
  ["group", "9"],
  ["textarea", "2"],
  ["outside", "2"],
  ["link", "2"],
  ["collapsed", "2"],
])("routes unclaimed %s/%s without changing the answer", async (kind, key) => {
  const { root, panel, group, composer, props, update } = await mountQuestion();
  let target: HTMLElement = group;
  if (kind === "textarea") {
    target = panel.querySelector("textarea")!;
  }
  if (kind === "outside") {
    target = root.appendChild(document.createElement("button"));
  }
  if (kind === "link") {
    await update({
      questions: [{ ...props.model.questions[0]!, url: "https://example.test/confirm" }],
    });
    target = panel.querySelector("a[href]")!;
  }
  if (kind === "collapsed") {
    button(panel, "collapse").click();
    await panel.updateComplete;
    target = button(panel, "collapsed-button");
    expect(document.activeElement).toBe(target);
  }
  const event = press(target, key);
  expect(document.activeElement).toBe(kind === "textarea" ? target : composer);
  expect(event.defaultPrevented).toBe(false);
  expectDraft(props, "Compact");
  expect(composer.value).toBe("kept draft");
});

it("yields answer and Other ownership while submission is pending", async () => {
  const { panel, group, composer, props } = await mountQuestion();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  panel.props = { ...props, onSubmit: () => pending };
  await panel.updateComplete;
  button(panel, "advance").click();
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
  const { panel, group, composer, props, update } = await mountQuestion();
  await update({
    questions: [
      {
        ...props.model.questions[0]!,
        options: Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index + 1}` })),
      },
    ],
  });
  press(group, "9");
  await panel.updateComplete;
  expectDraft(props, "Option 9");
  press(group, "0");
  expect(document.activeElement).toBe(composer);
  expect(panel.querySelectorAll("[data-shortcut]")).toHaveLength(9);
});

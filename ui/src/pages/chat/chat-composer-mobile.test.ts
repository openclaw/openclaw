/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createSessionGoalFixture } from "../../../../src/gateway/session-goal.test-support.js";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerControlsFixture,
  renderComposerFixture,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import type { ChatActivityPillsProps } from "./components/chat-activity-pills-types.ts";

beforeEach(() => {
  const matchMedia = window.matchMedia.bind(window);
  const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const result = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(result, "matches", { value: true });
    }
    return result;
  });
  onTestFinished(() => media.mockRestore());
});
afterEach(() => resetComposerFixture());

function mount(overrides: Parameters<typeof renderComposerFixture>[0] = {}) {
  const fixture = renderComposerFixture({ mobileComposer: true, ...overrides });
  document.body.append(fixture.container);
  const textarea = fixture.container.querySelector<HTMLTextAreaElement>("textarea")!;
  const focus = (target: HTMLElement = textarea) => {
    target.focus();
    flush();
  };
  const expectDraft = (value: string) => {
    expect(fixture.container.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe(value);
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 7]);
  };
  return { ...fixture, textarea, focus, expectDraft };
}

it("keeps the draft and caret through controls, outside focus, and keyboard recovery", async () => {
  const onComposerEditingChange = vi.fn();
  const { container, props, textarea, focus, expectDraft } = mount({
    mobileKeyboardVisible: true,
    draft: "A draft kept across focus changes",
    queue: [{ id: "queued", text: "Next message", createdAt: 1, sendState: "waiting-idle" }],
    composerControls: createComposerControlsFixture(),
    onComposerEditingChange,
  });
  await waitForSolid(() => expect(container.querySelector(".chat-queue__remove")).not.toBeNull());
  const outside = document.createElement("button");
  outside.textContent = "Outside composer";
  document.body.append(outside);
  onTestFinished(() => outside.remove());
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(false);
  textarea.focus();
  textarea.value = "Updated draft kept across focus changes";
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  textarea.setSelectionRange(2, 7);
  flush();
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(true);
  for (const selector of [".chat-composer-model-control", ".chat-queue__remove"]) {
    focus(container.querySelector<HTMLButtonElement>(selector)!);
    expect(onComposerEditingChange).toHaveBeenLastCalledWith(true);
  }
  focus(outside);
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(false);
  expect(textarea.value).toBe(props.draft);
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 7]);
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(props.onSend).not.toHaveBeenCalled();
  focus();
  renderComposerInto(container, { ...props, mobileKeyboardVisible: false });
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(false);
  expectDraft(props.draft);
  onComposerEditingChange.mockClear();
  textarea.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch" }),
  );
  flush();
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(true);
  const input = container.querySelector<HTMLElement>(".agent-chat__input")!;
  const footer = input.querySelector<HTMLElement>(".agent-chat__composer-footer")!;
  for (const [target, prevented] of [
    [input, true],
    [footer, true],
    [textarea, false],
  ] as const) {
    // Touch can retarget compatibility mouse events after the editor expands.
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(prevented);
  }
  expect(onComposerEditingChange.mock.calls.some(([editing]) => !editing)).toBe(false);
  expectDraft(props.draft);
  expect(props.onSend).not.toHaveBeenCalled();
});

it("does not send when expansion moves an action beneath the first editor tap", () => {
  const { container, props, textarea, focus } = mount({ draft: "Keep this" });
  textarea.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  focus();
  container
    .querySelector<HTMLButtonElement>(".chat-send-btn--send")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  expect(props.onSend).not.toHaveBeenCalled();
  expect(textarea.value).toBe("Keep this");
});

it("does not activate mobile editing in a desktop composer", () => {
  const onComposerEditingChange = vi.fn();
  const { container, focus } = mount({ mobileComposer: false, onComposerEditingChange });
  focus();
  expect(onComposerEditingChange).not.toHaveBeenCalledWith(true);
  expect(container.querySelector('[data-mobile-composer="true"]')).toBeNull();
});

it("mounts only visible activity pills without disturbing the mobile draft or focus", async () => {
  const empty: ChatActivityPillsProps = { presented: true, approvalPending: true };
  const onActivityPillsLayout = vi.fn();
  const { container, props, textarea, expectDraft } = mount({
    mobileActivityPills: empty,
    onActivityPillsLayout,
  });
  textarea.focus();
  textarea.value = "Unsaved mobile draft";
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  textarea.setSelectionRange(2, 7);
  await vi.dynamicImportSettled();
  flush();
  expect(container.querySelector(".chat-activity-pills")).toBeNull();
  expect(onActivityPillsLayout).not.toHaveBeenCalled();
  expectDraft("Unsaved mobile draft");

  const goal: NonNullable<ChatActivityPillsProps["goal"]> = {
    value: createSessionGoalFixture("mobile-goal", "Verify the release", { updatedAt: 2 }),
    executionConfirmed: false,
    onOpen: vi.fn(),
  };
  renderComposerInto(container, { ...props, mobileActivityPills: { ...empty, goal } });
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(container.querySelector('.activity-pill[data-family="goal"]')).not.toBeNull(),
  );
  const strip = container.querySelector<HTMLElement>(".chat-activity-pills")!;
  expect(strip.hidden).toBe(false);
  expectDraft("Unsaved mobile draft");

  renderComposerInto(container, { ...props, mobileActivityPills: empty });
  expect(container.querySelector(".chat-activity-pills")).toBeNull();
  expect(onActivityPillsLayout).toHaveBeenLastCalledWith(expect.objectContaining({ strip }), true);
  expectDraft("Unsaved mobile draft");
});

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  renderComposerFixture,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import "../../styles/base.css";
import "../../styles/chat/composer.css";

let viewport: { width: number; height: number };
beforeEach(() => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
});
afterEach(async () => {
  await resetComposerFixture();
  await page.viewport(viewport.width, viewport.height);
});

it("keeps mobile editing, field and caret while the native composer menu owns focus", async () => {
  await page.viewport(430, 800);
  const editing = vi.fn();
  const view = renderComposerFixture({
    mobileComposer: true,
    mobileKeyboardVisible: false,
    draft: "Keep this draft and selection",
    onComposerEditingChange: editing,
    capabilityMenu: {
      basePath: "",
      skills: [],
      skillsRead: null,
      mcpServers: [],
      toolsEffectiveResult: null,
      toolsEffectiveLoading: false,
      toolsEffectiveError: false,
      toolAccessMutationBlockedReason: null,
      webSearchBaseEnabled: true,
      mutationBlockedReason: null,
      canAdmin: true,
      adminBlockedReason: null,
      onLoadSkills: vi.fn(),
      onPatchToolOverrides: vi.fn(),
      onNavigate: vi.fn(),
    },
  });
  const { props } = view;
  document.body.append(view.container);
  view.container.style.cssText = "position:fixed;bottom:24px;left:16px;width:398px";
  const outside = document.createElement("button");
  outside.textContent = "Outside composer";
  document.body.append(outside);
  onTestFinished(() => outside.remove());
  const textarea = view.container.querySelector<HTMLTextAreaElement>("textarea")!;
  const input = view.container.querySelector<HTMLElement>(".agent-chat__input")!;
  const shell = view.container.querySelector<HTMLElement>(".agent-chat__composer-shell")!;
  await page.elementLocator(textarea).click();
  await expect.element(page.elementLocator(shell)).toHaveAttribute("data-composer-editing", "true");
  await Promise.all(input.getAnimations().map((animation) => animation.finished));
  renderComposerInto(view.container, { ...props, mobileKeyboardVisible: true });
  textarea.setSelectionRange(2, 8);
  editing.mockClear();
  const trigger = view.container.querySelector<HTMLButtonElement>(
    ".agent-chat__input-btn--attach",
  )!;
  await page.elementLocator(trigger).click();
  await expect.element(page.getByRole("menu")).toBeVisible();
  await userEvent.keyboard("{ArrowDown}");
  const menu = document.querySelector<HTMLElement>('[role="menu"]:popover-open')!;
  await expect.poll(() => menu.contains(document.activeElement)).toBe(true);
  renderComposerInto(view.container, { ...props, mobileKeyboardVisible: false });
  expect(shell.dataset.composerEditing).toBe("true");
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(trigger);
  expect(shell.dataset.composerEditing).toBe("true");
  expect(editing.mock.calls.some(([value]) => value === false)).toBe(false);
  expect(view.container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe(props.draft);
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 8]);
  expect(props.onSend).not.toHaveBeenCalled();
  await page.elementLocator(outside).click();
  await expect
    .element(page.elementLocator(shell))
    .toHaveAttribute("data-composer-editing", "false");
  outside.remove();
});

it("keeps editing and caret when pointer clicks empty composer padding and toolbar gaps", async () => {
  await page.viewport(430, 800);
  const editing = vi.fn();
  const view = renderComposerFixture({
    mobileComposer: true,
    draft: "Keep this draft and selection",
    onComposerEditingChange: editing,
  });
  // Chat's focusable content host receives native pointer focus from blank children.
  view.container.tabIndex = -1;
  document.body.append(view.container);
  view.container.style.cssText = "position:fixed;bottom:24px;left:16px;width:398px";
  const outside = document.createElement("button");
  outside.textContent = "Outside composer";
  document.body.append(outside);
  onTestFinished(() => outside.remove());
  const textarea = view.container.querySelector<HTMLTextAreaElement>("textarea")!;
  const input = view.container.querySelector<HTMLElement>(".agent-chat__input")!;
  const shell = view.container.querySelector<HTMLElement>(".agent-chat__composer-shell")!;
  const footer = view.container.querySelector<HTMLElement>(".agent-chat__composer-footer")!;
  const blur = vi.fn();
  textarea.addEventListener("blur", blur);
  await page.elementLocator(textarea).click();
  await expect.element(page.elementLocator(shell)).toHaveAttribute("data-composer-editing", "true");
  await Promise.all(input.getAnimations().map((animation) => animation.finished));
  textarea.setSelectionRange(2, 8);
  editing.mockClear();
  for (const [target, position] of [
    [input, { x: 3, y: 3 }],
    [footer, { x: footer.clientWidth / 2, y: footer.clientHeight - 2 }],
  ] as const) {
    await page.elementLocator(target).click({ position });
    expect(document.activeElement).toBe(textarea);
    expect(blur).not.toHaveBeenCalled();
    expect(editing.mock.calls.some(([value]) => value === false)).toBe(false);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 8]);
    expect(textarea.value).toBe(view.props.draft);
  }
  expect(view.props.onSend).not.toHaveBeenCalled();
  await page.elementLocator(outside).click();
  await expect
    .element(page.elementLocator(shell))
    .toHaveAttribute("data-composer-editing", "false");
});

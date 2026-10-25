import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  renderComposer as renderNewSession,
  resetComposerTestFixtures,
} from "../new-session/composer.test-support.ts";
import {
  findPrimaryButton,
  renderComposerFixture,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { makeCapabilities } from "./components/chat-composer-menu.test-support.ts";
import { SessionRailComposer } from "./components/chat-session-rail-composer.tsx";
import "../../styles/base.css";
import "../../styles/chat/composer.css";

let viewport: { width: number; height: number };
beforeEach(() => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
});
afterEach(async () => {
  await resetComposerFixture();
  resetComposerTestFixtures();
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
    capabilityMenu: makeCapabilities({ basePath: "" }),
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
  let focusedDuringPointerDown = false;
  textarea.addEventListener(
    "pointerdown",
    () => {
      focusedDuringPointerDown = document.activeElement === textarea;
    },
    { once: true },
  );
  await page.elementLocator(textarea).click();
  expect(focusedDuringPointerDown).toBe(true);
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

it.each(["enter", "modifier-enter"] as const)(
  "keeps mobile Side chat multiline and button-submitted with preference %s",
  async (sendShortcut) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const submit = vi.fn();
    const { container } = mountSolid(() => (
      <SessionRailComposer
        sessionKey="agent:test:main"
        client={null}
        presented={true}
        textareaRef={() => {}}
        companion={{ draft: "first second", turns: [], loading: false }}
        connected={true}
        pending={false}
        sendShortcut={sendShortcut}
        attachmentProps={{}}
        submit={submit}
      />
    ));
    document.body.append(container);
    const textarea = container.querySelector("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(5, 6);
    await userEvent.keyboard("{Enter}");
    expect(textarea.value).toBe("first\nsecond");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([6, 6]);
    await userEvent.keyboard("{Control>}{Enter}{/Control}{Meta>}{Enter}{/Meta}");
    expect(submit).not.toHaveBeenCalled();
    expect(textarea.getAttribute("enterkeyhint")).toBe("enter");
    expect(textarea.hasAttribute("aria-keyshortcuts")).toBe(false);
    container.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
    expect(submit).toHaveBeenCalledOnce();
  },
);

it.each(["iPhone", "Android"])(
  "keeps %s Return native in Chat and New Session",
  async (userAgent) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    for (const surface of ["chat", "new-session"] as const) {
      const submit = vi.fn();
      const input = vi.fn();
      const view =
        surface === "chat"
          ? renderComposerFixture({ draft: "first second", onSend: submit, onDraftChange: input })
          : renderNewSession({ message: "first second", onSubmit: submit, onInput: input });
      document.body.append(view.container);
      const textarea = view.container.querySelector("textarea")!;
      textarea.focus();
      textarea.setSelectionRange(5, 6);
      await userEvent.keyboard("{Enter}");
      expect(textarea.value).toBe("first\nsecond");
      expect(input.mock.calls.at(-1)?.[0]).toBe("first\nsecond");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([6, 6]);
      await userEvent.keyboard("{Control>}{Enter}{/Control}{Meta>}{Shift>}{Enter}{/Shift}{/Meta}");
      expect(submit).not.toHaveBeenCalled();
      expect(textarea.getAttribute("enterkeyhint")).toBe("enter");
      expect(textarea.hasAttribute("aria-keyshortcuts")).toBe(false);
      const button =
        surface === "chat"
          ? findPrimaryButton(view.container)
          : view.container.querySelector<HTMLButtonElement>(".new-session-page__start-submit")!;
      button.click();
      expect(submit).toHaveBeenCalledOnce();
    }
  },
);

it.each(["chat", "new-session"] as const)(
  "keeps reverse Tab native with slash suggestions in %s",
  async (surface) => {
    const view = surface === "chat" ? renderComposerFixture() : renderNewSession();
    const before = document.createElement("button");
    before.textContent = "Before composer";
    document.body.append(before, view.container);
    onTestFinished(() => before.remove());
    const textarea = view.container.querySelector("textarea")!;
    await userEvent.fill(textarea, "/to");
    await expect.element(page.getByRole("listbox")).toBeVisible();
    await userEvent.tab({ shift: true });
    expect(textarea.value).toBe("/to");
    expect(document.activeElement).not.toBe(textarea);
    expect(document.activeElement).not.toBe(document.body);
  },
);

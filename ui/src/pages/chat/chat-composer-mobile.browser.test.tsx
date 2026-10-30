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

it.each(["menu", "padding"] as const)("keeps the mobile draft through %s focus", async (target) => {
  await page.viewport(430, 800);
  const editing = vi.fn();
  const view = renderComposerFixture({
    mobileComposer: true,
    ...(target === "menu"
      ? {
          mobileKeyboardVisible: false,
          capabilityMenu: makeCapabilities({ basePath: "" }),
        }
      : {}),
    draft: "Keep this draft and selection",
    onComposerEditingChange: editing,
  });
  const { props, container } = view;
  if (target === "padding") {
    container.tabIndex = -1;
  }
  document.body.append(container);
  container.style.cssText = "position:fixed;bottom:24px;left:16px;width:398px";
  const outside = document.body.appendChild(document.createElement("button"));
  outside.textContent = "Outside composer";
  onTestFinished(() => outside.remove());
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const input = container.querySelector<HTMLElement>(".agent-chat__input")!;
  const shell = container.querySelector<HTMLElement>(".agent-chat__composer-shell")!;
  let focusedDuringPointerDown = false;
  textarea.addEventListener(
    "pointerdown",
    () => {
      focusedDuringPointerDown = document.activeElement === textarea;
    },
    { once: true },
  );
  const blur = vi.fn();
  textarea.addEventListener("blur", blur);
  await page.elementLocator(textarea).click();
  if (target === "menu") {
    expect(focusedDuringPointerDown).toBe(true);
  }
  await expect.element(page.elementLocator(shell)).toHaveAttribute("data-composer-editing", "true");
  await Promise.all(input.getAnimations().map((animation) => animation.finished));
  if (target === "menu") {
    renderComposerInto(container, { ...props, mobileKeyboardVisible: true });
  }
  textarea.setSelectionRange(2, 8);
  editing.mockClear();
  if (target === "menu") {
    const trigger = container.querySelector<HTMLButtonElement>(".agent-chat__input-btn--attach")!;
    await page.elementLocator(trigger).click();
    await expect.element(page.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    const menu = document.querySelector<HTMLElement>('[role="menu"]:popover-open')!;
    await expect.poll(() => menu.contains(document.activeElement)).toBe(true);
    renderComposerInto(container, { ...props, mobileKeyboardVisible: false });
    expect(shell.dataset.composerEditing).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    expect(shell.dataset.composerEditing).toBe("true");
  } else {
    const footer = container.querySelector<HTMLElement>(".agent-chat__composer-footer")!;
    for (const [element, position] of [
      [input, { x: 3, y: 3 }],
      [footer, { x: footer.clientWidth / 2, y: footer.clientHeight - 2 }],
    ] as const) {
      await page.elementLocator(element).click({ position });
      expect(document.activeElement).toBe(textarea);
      expect(blur).not.toHaveBeenCalled();
      expect(editing.mock.calls.some(([value]) => value === false)).toBe(false);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 8]);
      expect(textarea.value).toBe(props.draft);
    }
  }
  expect(editing.mock.calls.some(([value]) => value === false)).toBe(false);
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe(props.draft);
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 8]);
  expect(props.onSend).not.toHaveBeenCalled();
  await page.elementLocator(outside).click();
  await expect
    .element(page.elementLocator(shell))
    .toHaveAttribute("data-composer-editing", "false");
});

it.each([
  ["rail", "iPhone", "enter"],
  ["rail", "iPhone", "modifier-enter"],
  ["chat", "iPhone", "enter"],
  ["new-session", "iPhone", "enter"],
  ["chat", "Android", "enter"],
  ["new-session", "Android", "enter"],
] as const)(
  "keeps %s Return native on %s with shortcut %s",
  async (surface, userAgent, sendShortcut) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const submit = vi.fn();
    const input = vi.fn();
    const { container } =
      surface === "rail"
        ? mountSolid(() => (
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
          ))
        : surface === "chat"
          ? renderComposerFixture({ draft: "first second", onSend: submit, onDraftChange: input })
          : renderNewSession({ message: "first second", onSubmit: submit, onInput: input });
    document.body.append(container);
    const textarea = container.querySelector("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(5, 6);
    await userEvent.keyboard("{Enter}");
    expect(textarea.value).toBe("first\nsecond");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([6, 6]);
    if (surface !== "rail") {
      expect(input.mock.calls.at(-1)?.[0]).toBe("first\nsecond");
    }
    await userEvent.keyboard(
      surface === "rail"
        ? "{Control>}{Enter}{/Control}{Meta>}{Enter}{/Meta}"
        : "{Control>}{Enter}{/Control}{Meta>}{Shift>}{Enter}{/Shift}{/Meta}",
    );
    expect(submit).not.toHaveBeenCalled();
    expect(textarea.getAttribute("enterkeyhint")).toBe("enter");
    expect(textarea.hasAttribute("aria-keyshortcuts")).toBe(false);
    const button =
      surface === "chat"
        ? findPrimaryButton(container)
        : container.querySelector<HTMLButtonElement>(
            surface === "rail" ? "button[type=submit]" : ".new-session-page__start-submit",
          )!;
    button.click();
    expect(submit).toHaveBeenCalledOnce();
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

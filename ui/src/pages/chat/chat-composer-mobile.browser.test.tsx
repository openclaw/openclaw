import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  renderComposer as renderNewSession,
  resetComposerTestFixtures,
} from "../new-session/composer.test-support.ts";
import {
  createComposerControlsFixture,
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
  const { props, container } = renderComposerFixture({
    mobileComposer: true,
    mobileKeyboardVisible: target === "menu" ? false : undefined,
    capabilityMenu: target === "menu" ? makeCapabilities({ basePath: "" }) : undefined,
    draft: "Keep this draft and selection",
    onComposerEditingChange: editing,
  });
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
    // Native visibility precedes the lazy body and keyboard navigation runtime.
    await vi.dynamicImportSettled();
    const menu = document.querySelector<HTMLElement>('[role="menu"]:popover-open')!;
    await expect.poll(() => menu.contains(document.activeElement)).toBe(true);
    renderComposerInto(container, { ...props, mobileKeyboardVisible: false });
    expect(shell.dataset.composerEditing).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    expect(shell.dataset.composerEditing).toBe("true");
  } else {
    for (const [element, position] of [
      [input, { x: input.clientWidth / 2, y: 3 }],
      [input, { x: input.clientWidth / 2, y: input.clientHeight - 2 }],
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

it("keeps attachment chips at the same inset through mobile focus", async () => {
  await page.viewport(390, 844);
  const { container } = renderComposerFixture({
    mobileComposer: true,
    draft: "Messages take longer than usual to send",
    attachments: [
      { id: "diagnostics", fileName: "openclaw-diagnostics.txt", mimeType: "text/plain" },
    ],
  });
  document.body.append(container);
  container.style.cssText = "position:fixed;bottom:24px;left:16px;width:358px";
  const shell = container.querySelector<HTMLElement>(".agent-chat__composer-shell")!;
  const inset = () => {
    const surface = container.querySelector(".agent-chat__input")!.getBoundingClientRect();
    const chip = container.querySelector(".chat-attachment-thumb")!.getBoundingClientRect();
    const remove = container.querySelector(".chat-attachment-remove")!.getBoundingClientRect();
    return {
      left: chip.left - surface.left,
      top: chip.top - surface.top,
      remove: remove.top - surface.top,
    };
  };
  await expect.poll(() => container.querySelector(".chat-attachment-remove")).toBeTruthy();
  await expect
    .element(page.elementLocator(shell))
    .toHaveAttribute("data-composer-editing", "false");
  const resting = inset();
  container.querySelector("textarea")!.focus();
  await expect.element(page.elementLocator(shell)).toHaveAttribute("data-composer-editing", "true");
  const editing = inset();
  // The writing row's padding must not stack on the rail's own editor inset.
  expect(resting.left).toBeCloseTo(editing.left, 1);
  expect(resting.top).toBeCloseTo(editing.top, 1);
  expect(resting.remove).toBeGreaterThanOrEqual(0);
});

it.each([
  { width: 390, height: 844, draft: "Bottom gap" },
  { width: 844, height: 390, draft: "Bottom gap" },
  {
    width: 390,
    height: 844,
    draft: "A long draft that wraps inside the mobile text column before it gets focus",
  },
])(
  "keeps the mobile writing row stable at $width x $height: $draft",
  async ({ width, height, draft }) => {
    await page.viewport(width, height);
    const { container } = renderComposerFixture({
      mobileComposer: true,
      draft,
      permissionPicker: { canSelectFull: true, onSelect: vi.fn() },
      composerControls: createComposerControlsFixture(),
      attachments:
        width > height ? [{ id: "landscape", fileName: "notes.txt", mimeType: "text/plain" }] : [],
    });
    document.body.append(container);
    container.style.cssText = `position:fixed;bottom:0;left:16px;width:${width - 32}px`;
    const outside = document.body.appendChild(document.createElement("button"));
    outside.textContent = "Outside composer";
    onTestFinished(() => outside.remove());
    const shell = container.querySelector<HTMLElement>(".agent-chat__composer-shell")!;
    const input = container.querySelector<HTMLElement>(".agent-chat__input")!;
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    const attach = container.querySelector<HTMLButtonElement>(".agent-chat__input-btn--attach")!;
    const primary = findPrimaryButton(container);
    const permission = container.querySelector<HTMLButtonElement>(
      ".chat-controls__permission-trigger",
    )!;
    const model = container.querySelector<HTMLButtonElement>(".chat-composer-model-control")!;
    const elements = [shell, input, textarea, attach, primary];
    const rects = () =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
    const frame = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    await expect
      .element(page.elementLocator(shell))
      .toHaveAttribute("data-composer-editing", "false");
    if (width > height) {
      await expect.poll(() => container.querySelector(".chat-attachment-file__name")).toBeTruthy();
    }
    await frame();
    const resting = rects();
    expect(
      container.getBoundingClientRect().bottom - shell.getBoundingClientRect().bottom,
    ).toBeCloseTo(10, 1);
    const assertStable = () => {
      for (const [index, actual] of rects().entries()) {
        for (const key of ["x", "y", "width", "height"] as const) {
          expect(actual[key], `${elements[index]!.className} ${key}`).toBeCloseTo(
            resting[index]![key],
            1,
          );
        }
      }
    };
    // Sample the full former 180ms reveal window; stable endpoints alone hid
    // the layout animation and the textarea's change of columns.
    for (const focus of [true, false]) {
      if (focus) {
        textarea.focus();
      } else {
        outside.focus();
      }
      for (let count = 0; count < 20; count++) {
        await frame();
        assertStable();
      }
      expect(shell.dataset.composerEditing).toBe(String(focus));
      if (focus) {
        await expect.element(page.elementLocator(permission)).toBeVisible();
        await expect.element(page.elementLocator(model)).toBeVisible();
        expect(permission.getBoundingClientRect().bottom).toBeLessThan(
          input.getBoundingClientRect().top,
        );
        expect(model.getBoundingClientRect().bottom).toBeLessThan(
          input.getBoundingClientRect().top,
        );
        expect(permission.getBoundingClientRect().right).toBeLessThanOrEqual(
          model.getBoundingClientRect().left,
        );
        for (const control of [permission, model]) {
          const box = control.getBoundingClientRect();
          expect(box.top).toBeGreaterThanOrEqual(shell.getBoundingClientRect().top);
          const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          expect(target === control || (target !== null && control.contains(target))).toBe(true);
        }
      } else {
        await expect.element(page.elementLocator(permission)).not.toBeVisible();
        await expect.element(page.elementLocator(model)).not.toBeVisible();
      }
    }
    expect(container.querySelector("textarea")).toBe(textarea);
  },
);

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
    const before = document.createElement("input");
    before.setAttribute("aria-label", "Before composer");
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

import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { openMenu, surface } from "../../test-helpers/solid-menu.tsx";
import { SessionMenuShortcut } from "../session-menu-view.tsx";
import { Kbd, KeyboardShortcut, ShortcutHint } from "./kbd.tsx";
import { Menu } from "./menu.tsx";
import "../../styles.css";
import "../../styles/session-menu.css";
import "../../styles/command-palette.css";
import "../../styles/chat/composer.css";
import "../../styles/chat/side-panel.css";
import "../kbd.css";

afterEach(cleanup);

it.each([
  { dir: "ltr", width: 390 },
  { dir: "rtl", width: 768 },
  { dir: "ltr", width: 1366 },
  { dir: "rtl", width: 1440 },
] as const)(
  "shares tooltip badges across menu and popover shortcut skins in $dir at $width px",
  async ({ dir, width }) => {
    await page.viewport(width, 844);
    const view = render(() => (
      <>
        <ShortcutHint label="Command palette" combo={{ key: "k", modifiers: ["mod"] }} />
        <Menu
          id="badge-pattern"
          label="Actions"
          dir={dir}
          class="session-menu"
          items={[
            { id: "session", label: "Session", details: <SessionMenuShortcut shortcut="p" /> },
            {
              id: "account",
              label: "Settings",
              details: (
                <KeyboardShortcut
                  class="session-menu__shortcut"
                  combo={{ key: "Comma", modifiers: ["mod", "shift"] }}
                />
              ),
            },
            {
              id: "layout",
              label: "Layout",
              type: "checkbox",
              checked: true,
              details: (
                <KeyboardShortcut
                  class="side-panel-type-option__shortcut"
                  combo={{ key: "u", modifiers: ["mod", "alt", "shift"] }}
                />
              ),
            },
          ]}
        />
        <div class="cmd-palette__create">
          <Kbd keys="⏎" />
        </div>
        <div class="cmd-palette__footer">
          <Kbd keys={["↑", "↓"]} />
        </div>
        <div class="sidebar-region--desktop">
          <div class="side-panel-launcher__item">
            <Kbd keys="B" />
          </div>
        </div>
        <div class="chat-controls__model-option-action">
          <Kbd keys="2" />
        </div>
      </>
    ));
    await openMenu("badge-pattern");
    const reference = getComputedStyle(view.container.querySelector(".shortcut-hint__keys")!);
    const skin = (style: CSSStyleDeclaration) => [
      style.backgroundColor,
      style.color,
      style.borderRadius,
      style.paddingInlineStart,
      style.paddingInlineEnd,
      style.fontFamily,
    ];
    expect(Number.parseFloat(reference.paddingInlineStart)).toBeGreaterThan(0);
    for (const badge of view.container.querySelectorAll("kbd")) {
      expect(skin(getComputedStyle(badge)), badge.outerHTML).toEqual(skin(reference));
    }
    const hints = [...surface("badge-pattern").querySelectorAll("kbd")];
    const edge = dir === "rtl" ? "left" : "right";
    const ends = hints.map((hint) => hint.getBoundingClientRect()[edge]);
    expect(ends).toHaveLength(3);
    expect(Math.max(...ends) - Math.min(...ends)).toBeLessThan(1);
  },
);

it("right-aligns leaf shortcuts when only unrelated rows have submenu arrows", async () => {
  render(() => (
    <Menu
      id="account-rail"
      label="Account"
      items={[
        { id: "settings", label: "Settings", details: <Kbd keys="⌘," /> },
        { id: "help", label: "Help", children: [{ id: "docs", label: "Docs" }] },
      ]}
    />
  ));
  await openMenu("account-rail");
  const row = surface("account-rail").querySelector<HTMLElement>('[data-value="settings"]')!;
  const badge = row.querySelector("kbd")!;
  const end =
    row.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(row).paddingInlineEnd);
  expect(Math.abs(end - badge.getBoundingClientRect().right)).toBeLessThan(1);
});

import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ChatPaneLayoutMenu } from "../../pages/chat/components/chat-header-panel-actions.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { KeyboardShortcut } from "./kbd.tsx";
import { Menu, type MenuItem } from "./menu.tsx";
import "../../styles/base.css";
import "../../styles/layout.css";
import "../../styles/session-menu.css";
import "../kbd.css";
import "../../styles/chat/layout.css";
import "../../styles/chat/split-view.css";

afterEach(cleanup);

it.each(["ltr", "rtl"] as const)(
  "aligns shortcut ends across plain, checked, unchecked, radio and submenu rows in %s",
  async (dir) => {
    await page.viewport(1000, 700);
    const hint = (key: "b" | "u") => (
      <KeyboardShortcut
        class="session-menu__shortcut"
        combo={{ key, modifiers: key === "b" ? ["mod"] : ["mod", "alt", "shift"] }}
        applePlatform
      />
    );
    const entries: MenuItem[] = [
      { id: "plain", label: "Plain", details: hint("b") },
      { id: "off", label: "Unchecked", type: "checkbox", checked: false, details: hint("u") },
      { id: "on", label: "Checked", type: "checkbox", checked: true, details: hint("b") },
      { id: "radio", label: "Radio", type: "radio", checked: true, details: hint("u") },
      {
        id: "branch",
        label: "Submenu",
        details: hint("b"),
        children: [{ id: "child", label: "Child" }],
      },
    ];
    render(() => (
      <Menu id="alignment" label="Actions" dir={dir} class="session-menu" items={entries} />
    ));
    await userEvent.click(page.getByRole("button", { name: "Actions" }));
    const menu = document.getElementById("alignment:content")!;
    await expect.element(page.elementLocator(menu)).toBeVisible();
    await waitForSolid(() => expect(menu.dataset.phase).toBe("open"));
    const ends = [...menu.querySelectorAll<HTMLElement>(".session-menu__shortcut")].map(
      (element) => {
        const bounds = element.getBoundingClientRect();
        return dir === "rtl" ? bounds.left : bounds.right;
      },
    );
    expect(ends).toHaveLength(5);
    expect(Math.max(...ends) - Math.min(...ends)).toBeLessThan(1);
  },
);

it("keeps Layout hints aligned before and after panel styles load, and hidden on mobile", async () => {
  await page.viewport(1000, 800);
  render(() => (
    <ChatPaneLayoutMenu
      paneId="layout-alignment"
      narrow={false}
      panelMenuActions={[
        {
          id: "terminal",
          label: "Terminal",
          icon: "terminal",
          shortcut: { key: "Backquote", modifiers: ["ctrl"] },
          onActivate() {},
        },
        {
          id: "browser",
          label: "Browser",
          icon: "globe",
          shortcut: { key: "u", modifiers: ["mod", "alt", "shift"] },
          onActivate() {},
        },
        {
          id: "files",
          label: "Files",
          icon: "fileText",
          active: false,
          shortcut: { key: "b", modifiers: ["mod", "shift"] },
          onActivate() {},
        },
        {
          id: "review",
          label: "Review",
          icon: "diff",
          active: true,
          shortcut: { key: "e", modifiers: ["mod", "alt", "shift"] },
          onActivate() {},
        },
      ]}
    />
  ));
  await userEvent.click(page.getByRole("button", { name: "Layout", exact: true }));
  const menu = page.getByRole("menu", { name: "Layout", exact: true }).element();
  await waitForSolid(() => {
    expect(menu.getAttribute("data-phase")).toBe("open");
    // The opening transition scales DOM bounds; measure its final geometry.
    expect(getComputedStyle(menu).scale).toBe("1");
  });
  await Promise.all(menu.getAnimations().map((animation) => animation.finished));
  const hints = [...menu.querySelectorAll<HTMLElement>(".shortcut-kbd")];
  expect(hints).toHaveLength(4);
  const bounds = () => hints.map((hint) => hint.getBoundingClientRect());
  const before = bounds();
  expect(
    Math.max(...before.map((rect) => rect.right)) - Math.min(...before.map((rect) => rect.right)),
  ).toBeLessThan(1);
  await import("../../styles/chat/side-panel.css");
  const after = bounds();
  expect(after).toHaveLength(before.length);
  // WebKit can retain ~0.03px transform rounding after the opening scale settles;
  // a real layout shift from the panel styles moves hints by whole pixels.
  for (const [index, rect] of after.entries()) {
    expect(Math.abs(rect.right - before[index]!.right)).toBeLessThan(0.5);
    expect(Math.abs(rect.width - before[index]!.width)).toBeLessThan(0.5);
  }
  const check = menu.querySelector<HTMLElement>('[aria-checked="true"] > .oc-menu-item__check')!;
  expect(check.getBoundingClientRect().left).toBeGreaterThan(before[3]!.right);
  await page.viewport(390, 800);
  for (const hint of hints) {
    expect(hint.getBoundingClientRect().width).toBe(0);
  }
});

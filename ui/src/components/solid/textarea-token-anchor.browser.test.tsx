import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { phase } from "../../test-helpers/solid-menu.tsx";
import { createTextareaTokenAnchor } from "../textarea-token-anchor.ts";
import { Menu, type MenuHandle } from "./menu.tsx";
import "../../styles/base.css";

let anchor: ReturnType<typeof createTextareaTokenAnchor> | undefined;
const hosts: HTMLElement[] = [];
afterEach(() => {
  anchor?.close();
  anchor = undefined;
  cleanup();
  hosts.splice(0).forEach((host) => host.remove());
});

function mountCaret(value: string, container?: HTMLElement) {
  let menu!: MenuHandle;
  let textarea!: HTMLTextAreaElement;
  render(
    () => (
      <>
        <textarea
          ref={(element) => {
            textarea = element;
          }}
          value={value}
          style={{
            width: "240px",
            height: "64px",
            "font-size": "16px",
            "line-height": "20px",
            margin: "80px",
          }}
        />
        <Menu
          id="caret-menu"
          label="Suggestions"
          items={[{ id: "result", label: "Result" }]}
          ref={(handle) => {
            menu = handle;
          }}
        />
      </>
    ),
    container ? { container } : undefined,
  );
  flush();
  return { menu, textarea };
}

function caretPoint(surface: HTMLElement) {
  const root = surface.getRootNode();
  const container = root instanceof ShadowRoot ? root : document;
  const name = surface.style.getPropertyValue("position-anchor");
  const point = [...container.querySelectorAll<HTMLElement>("[aria-hidden]")].find((element) =>
    element.style.getPropertyValue("anchor-name").split(/,\s*/u).includes(name),
  );
  if (!point) {
    throw new Error("Expected the menu's measured caret anchor");
  }
  return point;
}

function expectMenuHit(menu: MenuHandle) {
  const item = menu.overlay.surface.querySelector<HTMLButtonElement>("[role=menuitem]")!;
  const bounds = item.getBoundingClientRect();
  const root = item.getRootNode();
  const hit = (root instanceof ShadowRoot ? root : document).elementFromPoint(
    bounds.left + bounds.width / 2,
    bounds.top + bounds.height / 2,
  );
  expect(item.contains(hit), "the visible caret menu item receives pointer input").toBe(true);
}

it("positions a native menu at the measured caret and returns focus to the editor", async () => {
  const { menu, textarea } = mountCaret("hello @person");
  anchor = createTextareaTokenAnchor(() => anchor?.close());
  textarea.focus();
  anchor.updateNative(menu.overlay, textarea, 6);
  await expect.poll(() => menu.overlay.open).toBe(true);
  await phase(menu.overlay.surface, "open");
  expect(menu.overlay.trigger).toBe(textarea);
  const point = caretPoint(menu.overlay.surface).getBoundingClientRect();
  const editor = textarea.getBoundingClientRect();
  expect(point.left).toBeGreaterThan(editor.left);
  expect(point.left).toBeLessThan(editor.right);
  expect(point.top).toBeGreaterThanOrEqual(editor.top);
  expect(point.bottom).toBeLessThanOrEqual(editor.bottom);
  expect(menu.overlay.surface.style.getPropertyValue("position-anchor")).not.toBe("");
  expect(menu.overlay.surface.style.left).toBe("");
  expect(menu.overlay.surface.style.top).toBe("");
  expectMenuHit(menu);
  menu.overlay.surface.querySelector<HTMLButtonElement>("[role=menuitem]")!.focus();
  menu.overlay.request(false, "return");
  expect(document.activeElement).toBe(textarea);
});

it("retires the native menu when its token scrolls outside the textarea", async () => {
  const { menu, textarea } = mountCaret(
    Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
  );
  anchor = createTextareaTokenAnchor(() => anchor?.close());
  anchor.updateNative(menu.overlay, textarea, 0);
  await expect.poll(() => menu.overlay.open).toBe(true);
  const point = caretPoint(menu.overlay.surface);
  textarea.scrollTop = textarea.scrollHeight;
  textarea.dispatchEvent(new Event("scroll"));
  await expect.poll(() => menu.overlay.open).toBe(false);
  expect(point.isConnected).toBe(false);
});

it("rebinds to another editor and can reopen after synchronous retirement", async () => {
  const { menu, textarea } = mountCaret("hello @person");
  anchor = createTextareaTokenAnchor(() => anchor?.close());
  anchor.updateNative(menu.overlay, textarea, 6);
  await expect.poll(() => menu.overlay.open).toBe(true);
  const previousPoint = caretPoint(menu.overlay.surface);
  const nextTextarea = document.createElement("textarea");
  nextTextarea.value = "next @person";
  nextTextarea.style.cssText = textarea.style.cssText;
  document.body.append(nextTextarea);
  hosts.push(nextTextarea);
  anchor.updateNative(menu.overlay, nextTextarea, 5);
  expect(previousPoint.isConnected).toBe(false);
  await expect.poll(() => menu.overlay.open).toBe(true);
  expect(menu.overlay.trigger).toBe(nextTextarea);
  const nextPoint = caretPoint(menu.overlay.surface);
  expect(nextPoint).not.toBe(previousPoint);

  onTestFinished(
    menu.overlay.subscribe((open) => {
      if (!open) {
        anchor?.close();
      }
    }),
  );
  anchor.close();
  expect(menu.overlay.open).toBe(false);
  expect(nextPoint.isConnected).toBe(false);
  anchor.updateNative(menu.overlay, nextTextarea, 5);
  await expect.poll(() => menu.overlay.open).toBe(true);
  expect(caretPoint(menu.overlay.surface).isConnected).toBe(true);
});

it.each(["open", "closed"] as const)(
  "positions caret menus inside a %s shadow root",
  async (mode) => {
    const host = document.createElement("section");
    const root = host.attachShadow({ mode });
    const container = document.createElement("div");
    root.append(container);
    document.body.append(host);
    hosts.push(host);
    const { menu, textarea } = mountCaret("hello @person", container);
    anchor = createTextareaTokenAnchor(() => anchor?.close());
    textarea.focus();
    anchor.updateNative(menu.overlay, textarea, 6);
    await phase(menu.overlay.surface, "open");
    expect(menu.overlay.trigger).toBe(textarea);
    const point = caretPoint(menu.overlay.surface);
    const pointBox = point.getBoundingClientRect();
    const menuBox = menu.overlay.surface.getBoundingClientRect();
    expect(point.getRootNode()).toBe(root);
    expect(getComputedStyle(menu.overlay.surface).position).toBe("fixed");
    expect(menuBox.width).toBeGreaterThan(0);
    expect(menuBox.height).toBeGreaterThan(0);
    expect(Math.abs(menuBox.left - pointBox.left)).toBeLessThan(1);
    expect(menuBox.bottom).toBeLessThanOrEqual(pointBox.top);
    expectMenuHit(menu);
    menu.overlay.surface.querySelector<HTMLButtonElement>("[role=menuitem]")!.focus();
    menu.overlay.request(false, "return");
    expect(root.activeElement).toBe(textarea);
    anchor.close();
    expect(point.isConnected).toBe(false);
  },
);

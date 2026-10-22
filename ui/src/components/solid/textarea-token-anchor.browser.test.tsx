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
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.cssText = "width:240px;height:64px;font-size:16px;line-height:20px;margin:80px";
  const view = render(
    () => (
      <Menu
        id="caret-menu"
        label="Suggestions"
        items={[{ id: "result", label: "Result" }]}
        ref={(handle) => (menu = handle)}
      />
    ),
    container ? { container } : undefined,
  );
  view.container.prepend(textarea);
  flush();
  return { menu, textarea };
}

async function openCaret(menu: MenuHandle, textarea: HTMLTextAreaElement, offset = 6) {
  const current = (anchor = createTextareaTokenAnchor(() => anchor?.close()));
  current.updateNative(menu.overlay, textarea, offset);
  await expect.poll(() => menu.overlay.open).toBe(true);
  return current;
}

function returnFocus(menu: MenuHandle, root: Document | ShadowRoot, textarea: HTMLTextAreaElement) {
  menu.overlay.surface.querySelector<HTMLButtonElement>("[role=menuitem]")!.focus();
  menu.overlay.request(false, "return");
  expect(root.activeElement).toBe(textarea);
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

it.each(["document", "open", "closed"] as const)(
  "positions and focuses a caret menu (%s root)",
  async (mode) => {
    let root: Document | ShadowRoot = document;
    let container: HTMLElement | undefined;
    if (mode !== "document") {
      const host = document.createElement("section");
      root = host.attachShadow({ mode });
      container = document.createElement("div");
      root.append(container);
      document.body.append(host);
      hosts.push(host);
    }
    const { menu, textarea } = mountCaret("hello @person", container);
    const surface = menu.overlay.surface;
    textarea.focus();
    const current = await openCaret(menu, textarea);
    await phase(surface, "open");
    expect(menu.overlay.trigger).toBe(textarea);
    const point = caretPoint(surface);
    const pointBox = point.getBoundingClientRect();
    if (mode !== "document") {
      const menuBox = surface.getBoundingClientRect();
      expect(point.getRootNode()).toBe(root);
      expect(getComputedStyle(surface).position).toBe("fixed");
      expect(menuBox.width).toBeGreaterThan(0);
      expect(menuBox.height).toBeGreaterThan(0);
      expect(Math.abs(menuBox.left - pointBox.left)).toBeLessThan(1);
      expect(menuBox.bottom).toBeLessThanOrEqual(pointBox.top);
    } else {
      const editor = textarea.getBoundingClientRect();
      expect(pointBox.left).toBeGreaterThan(editor.left);
      expect(pointBox.left).toBeLessThan(editor.right);
      expect(pointBox.top).toBeGreaterThanOrEqual(editor.top);
      expect(pointBox.bottom).toBeLessThanOrEqual(editor.bottom);
      expect(surface.style.getPropertyValue("position-anchor")).not.toBe("");
      expect(surface.style).toMatchObject({ left: "", top: "" });
    }
    expectMenuHit(menu);
    returnFocus(menu, root, textarea);
    current.close();
    expect(point.isConnected).toBe(false);
  },
);

it("retires the native menu when its token scrolls outside the textarea", async () => {
  const { menu, textarea } = mountCaret(
    Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
  );
  await openCaret(menu, textarea, 0);
  const point = caretPoint(menu.overlay.surface);
  textarea.scrollTop = textarea.scrollHeight;
  textarea.dispatchEvent(new Event("scroll"));
  await expect.poll(() => menu.overlay.open).toBe(false);
  expect(point.isConnected).toBe(false);
});

it("rebinds to another editor and can reopen after synchronous retirement", async () => {
  const { menu, textarea } = mountCaret("hello @person");
  const current = await openCaret(menu, textarea);
  const previousPoint = caretPoint(menu.overlay.surface);
  const nextTextarea = document.createElement("textarea");
  nextTextarea.value = "next @person";
  nextTextarea.style.cssText = textarea.style.cssText;
  document.body.append(nextTextarea);
  hosts.push(nextTextarea);
  current.updateNative(menu.overlay, nextTextarea, 5);
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
  current.close();
  expect(menu.overlay.open).toBe(false);
  expect(nextPoint.isConnected).toBe(false);
  current.updateNative(menu.overlay, nextTextarea, 5);
  await expect.poll(() => menu.overlay.open).toBe(true);
  expect(caretPoint(menu.overlay.surface).isConnected).toBe(true);
});

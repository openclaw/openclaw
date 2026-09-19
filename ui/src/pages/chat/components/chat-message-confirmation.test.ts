import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import * as localStorageModule from "../../../local-storage.ts";
import {
  dismissConfirmedActionPopovers,
  isConfirmedActionPopoverFocused,
  renderRewindButton,
} from "./chat-message-confirmation.ts";

afterEach(() => {
  dismissConfirmedActionPopovers(document.body);
  document.body.replaceChildren();
  window.localStorage.removeItem("openclaw:skip-rewind-confirm");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("tracks focused confirmation ownership through dismissal of another pane", () => {
  const first = document.createElement("section");
  const second = document.createElement("section");
  document.body.append(first, second);
  render(
    renderRewindButton(() => {}),
    first,
  );
  render(
    renderRewindButton(() => {}),
    second,
  );
  first.querySelector<HTMLButtonElement>("button")!.click();
  expect(isConfirmedActionPopoverFocused(first)).toBe(true);
  expect(isConfirmedActionPopoverFocused(second)).toBe(false);
  dismissConfirmedActionPopovers(second);
  expect(isConfirmedActionPopoverFocused(first)).toBe(true);
  dismissConfirmedActionPopovers(first);
  expect(isConfirmedActionPopoverFocused(first)).toBe(false);
  expect(document.querySelector(".chat-confirm-popover")).toBeNull();
});

it.each([
  { event: "window resize", left: 0, top: 0, width: 390, height: 844 },
  { event: "visual viewport resize", left: 0, top: 0, width: 844, height: 390 },
  { event: "visual viewport scroll", left: 900, top: 600, width: 390, height: 244 },
])("keeps the open confirmation reachable after $event", ({ event, left, top, width, height }) => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.spyOn(localStorageModule, "getSafeLocalStorage").mockReturnValue(window.localStorage);
  const viewport = Object.assign(new EventTarget(), {
    offsetLeft: 0,
    offsetTop: 0,
    width: 1440,
    height: 900,
  });
  vi.stubGlobal("visualViewport", viewport);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("chat-group-rewind")
        ? new DOMRect(1000, 460, 24, 24)
        : new DOMRect(0, 0, 200, 100);
    },
  );
  const owner = document.createElement("section");
  document.body.append(owner);
  const onAction = vi.fn();
  render(renderRewindButton(onAction), owner);
  const trigger = owner.querySelector<HTMLButtonElement>("button")!;
  trigger.click();
  vi.advanceTimersToNextFrame();
  const popover = document.querySelector<HTMLElement>(".chat-confirm-popover")!;
  const cancel = popover.querySelector<HTMLButtonElement>(".chat-confirm-popover__cancel")!;
  const check = popover.querySelector<HTMLInputElement>("input")!;
  check.checked = true;

  Object.assign(viewport, { offsetLeft: left, offsetTop: top, width, height });
  const target = event === "window resize" ? window : viewport;
  target.dispatchEvent(new Event(event.endsWith("scroll") ? "scroll" : "resize"));
  vi.advanceTimersToNextFrame();

  expect(document.querySelector(".chat-confirm-popover")).toBe(popover);
  expect(document.activeElement).toBe(cancel);
  expect(check.checked).toBe(true);
  expect(Number.parseFloat(popover.style.left)).toBeGreaterThanOrEqual(left + 8);
  expect(Number.parseFloat(popover.style.left) + 200).toBeLessThanOrEqual(left + width - 8);
  expect(Number.parseFloat(popover.style.top)).toBeGreaterThanOrEqual(top + 8);
  expect(Number.parseFloat(popover.style.top) + 100).toBeLessThanOrEqual(top + height - 8);
  expect(onAction).not.toHaveBeenCalled();
  expect(window.localStorage.getItem("openclaw:skip-rewind-confirm")).toBeNull();

  window.dispatchEvent(new Event("resize"));
  cancel.click();
  vi.advanceTimersToNextFrame();
  expect(document.querySelector(".chat-confirm-popover")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(onAction).not.toHaveBeenCalled();
  expect(window.localStorage.getItem("openclaw:skip-rewind-confirm")).toBeNull();
});

import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  dismissConfirmedActionPopovers,
  isConfirmedActionPopoverFocused,
  RewindButton,
} from "./chat-message-confirmation-view.tsx";

beforeEach(() => localStorage.removeItem("openclaw:skip-rewind-confirm"));
afterEach(() => {
  dismissConfirmedActionPopovers(document.body);
  cleanupSolid();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function element(selector: string, root: ParentNode = document) {
  const result = root.querySelector<HTMLElement>(selector);
  expect(result).toBeInstanceOf(HTMLElement);
  return result!;
}

function button(selector: string, root: ParentNode = document) {
  const result = root.querySelector<HTMLButtonElement>(selector);
  expect(result).toBeInstanceOf(HTMLButtonElement);
  return result!;
}

function fixture() {
  const container = document.body.appendChild(document.createElement("section"));
  const onAction = vi.fn();
  mountSolid(() => createComponent(RewindButton, { onRewind: onAction }), { container });
  const trigger = button("button", container);
  return {
    container,
    trigger,
    onAction,
    open() {
      trigger.click();
      return element(".chat-confirm-popover");
    },
  };
}

function listenerHarness() {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    callbacks.push(callback),
  );
  const flushFrames = () => callbacks.splice(0).forEach((callback) => callback(performance.now()));
  const docAdd = vi.spyOn(document, "addEventListener");
  const docRemove = vi.spyOn(document, "removeEventListener");
  const winAdd = vi.spyOn(window, "addEventListener");
  const winRemove = vi.spyOn(window, "removeEventListener");
  const events = [
    ["click", docAdd, docRemove],
    ["contextmenu", docAdd, docRemove],
    ["keydown", winAdd, winRemove],
  ] as const;
  const last = (event: string, calls: readonly unknown[][]) =>
    calls.findLast(
      ([type, listener, options]) => type === event && options === true && listener,
    )?.[1] ?? null;
  return { flushFrames, events, last };
}

function armed() {
  const harness = listenerHarness();
  const current = fixture();
  const popover = current.open();
  harness.flushFrames();
  const listeners = harness.events.map(([event, add, remove]) => {
    const listener = harness.last(event, add.mock.calls);
    expect(typeof listener).toBe("function");
    return { event, listener, remove };
  });
  return {
    ...current,
    popover,
    dismissed() {
      expect(popover.isConnected).toBe(false);
      for (const { event, listener, remove } of listeners) {
        expect(
          remove.mock.calls.filter(
            ([type, removed, capture]) =>
              type === event && capture === true && removed === listener,
          ),
        ).toHaveLength(1);
      }
    },
  };
}

it("clamps the confirmation inside shifted visual viewports", () => {
  vi.stubGlobal("innerWidth", 320);
  vi.stubGlobal("innerHeight", 240);
  vi.stubGlobal("visualViewport", { offsetLeft: 320, offsetTop: 300, width: 320, height: 240 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("chat-group-rewind")
      ? new DOMRect(620, 540, 24, 24)
      : this.classList.contains("chat-confirm-popover")
        ? new DOMRect(0, 0, 200, 80)
        : new DOMRect();
  });
  const popover = fixture().open();
  expect(popover.parentElement).toBe(document.body);
  expect([popover.dataset.placement, popover.style.top, popover.style.left]).toEqual([
    "above",
    "452px",
    "432px",
  ]);
});

it("exposes dialog semantics and keeps keyboard focus inside the confirmation", () => {
  const popover = fixture().open();
  const check = element(".chat-confirm-popover__check", popover);
  expect(check).toBeInstanceOf(HTMLInputElement);
  const cancel = button(".chat-confirm-popover__cancel", popover);
  const confirm = button(".chat-confirm-popover__yes", popover);
  expect([popover.getAttribute("role"), popover.getAttribute("aria-modal")]).toEqual([
    "dialog",
    "true",
  ]);
  expect(popover.getAttribute("aria-label")).toBe(
    element(".chat-confirm-popover__text", popover).textContent,
  );
  expect(element(".chat-confirm-popover__remember span", popover).textContent).toBe(
    "Don't ask again",
  );
  expect(cancel.textContent).toBe("Cancel");
  expect(document.activeElement).toBe(cancel);
  for (const [from, to, shiftKey] of [
    [confirm, check, false],
    [check, confirm, true],
  ] as const) {
    from.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
      shiftKey,
    });
    from.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(to);
  }
});

it.each(["Escape", "Cancel", "Rewind"] as const)(
  "dismisses confirmation listeners and transfers focus after %s",
  (action) => {
    const current = armed();
    const target = button(
      action === "Rewind" ? ".chat-confirm-popover__yes" : ".chat-confirm-popover__cancel",
      current.popover,
    );
    const leakedKeydown = vi.fn();
    document.addEventListener("keydown", leakedKeydown);
    try {
      if (action === "Rewind") {
        target.focus();
      }
      const event =
        action === "Escape"
          ? new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
          : new MouseEvent("click", { bubbles: true });
      target.dispatchEvent(event);
      if (action === "Escape") {
        expect(event.defaultPrevented).toBe(true);
        expect(leakedKeydown).not.toHaveBeenCalled();
      }
      current.dismissed();
      expect(current.onAction).toHaveBeenCalledTimes(action === "Rewind" ? 1 : 0);
      if (action === "Rewind") {
        expect(document.activeElement).not.toBe(current.trigger);
      } else {
        expect(document.activeElement).toBe(current.trigger);
      }
    } finally {
      document.removeEventListener("keydown", leakedKeydown);
    }
  },
);

it("dismisses only confirmations contained by the requested owner", () => {
  const current = armed();
  const sibling = fixture();
  sibling.trigger.click();
  const siblingPopover = [...document.querySelectorAll<HTMLElement>(".chat-confirm-popover")].find(
    (popover) => popover !== current.popover,
  );
  dismissConfirmedActionPopovers(current.container);
  current.dismissed();
  expect(siblingPopover?.isConnected).toBe(true);
  dismissConfirmedActionPopovers(sibling.container);
});

it("dismisses a portaled confirmation when its owner is detached", async () => {
  const current = armed();
  current.container.remove();
  await Promise.resolve();
  current.dismissed();
});

it("does not attach an outside-click listener after owner cleanup before the next frame", () => {
  const harness = listenerHarness();
  const current = fixture();
  current.open();
  const listeners = harness.events.slice(1).map(([event, add, remove]) => ({
    event,
    remove,
    listener: harness.last(event, add.mock.calls),
  }));
  listeners.forEach(({ listener }) => expect(typeof listener).toBe("function"));
  dismissConfirmedActionPopovers(current.container);
  harness.flushFrames();
  expect(document.querySelector(".chat-confirm-popover")).toBeNull();
  expect(harness.last("click", harness.events[0][1].mock.calls)).toBeNull();
  for (const { event, listener, remove } of listeners) {
    expect(
      remove.mock.calls.filter(
        ([type, removed, capture]) => type === event && capture === true && removed === listener,
      ),
    ).toHaveLength(1);
  }
});

it("tracks focused confirmation ownership through dismissal of another pane", () => {
  const first = fixture();
  const second = fixture();
  first.open();
  expect(isConfirmedActionPopoverFocused(first.container)).toBe(true);
  expect(isConfirmedActionPopoverFocused(second.container)).toBe(false);
  dismissConfirmedActionPopovers(second.container);
  expect(isConfirmedActionPopoverFocused(first.container)).toBe(true);
  dismissConfirmedActionPopovers(first.container);
  expect(isConfirmedActionPopoverFocused(first.container)).toBe(false);
  expect(document.querySelector(".chat-confirm-popover")).toBeNull();
});

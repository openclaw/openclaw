/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNativeLinkRouting } from "../app/native-link-routing.ts";
import { resetTranscriptSession } from "../pages/chat/components/chat-thread-interactions.ts";
import { installDialogPolyfill, waitForRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import {
  enhanceMarkdownTables,
  handleMarkdownTableInteraction,
  releaseMarkdownTables,
} from "./markdown-tables.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const writeText = vi.fn(async (_text: string) => undefined);

let clipboardDescriptor: PropertyDescriptor | undefined;
let mutationObserverDescriptor: PropertyDescriptor | undefined;
let resizeObserverDescriptor: PropertyDescriptor | undefined;
let restoreDialogPolyfill: () => void;

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}

const markdown = `Open agent:main:dashboard:table

<progress value="3" max="7"></progress>

| Name | Value |
| --- | --- |
| Alpha | One |`;

class TestMutationObserver {
  static instances: TestMutationObserver[] = [];
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();

  constructor(readonly callback: MutationCallback) {
    TestMutationObserver.instances.push(this);
  }
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
}

function interactiveOwner(content = markdown): {
  owner: HTMLElement;
  shell: HTMLElement;
  viewport: HTMLElement;
} {
  const owner = document.createElement("div");
  owner.className = "chat-thread";
  owner.innerHTML = `<div class="chat-text">${toSanitizedMarkdownHtml(content, {
    progressBars: true,
    sessionLinks: true,
    tableInteractions: "enabled",
  })}</div>`;
  document.body.append(owner);
  const shell = owner.querySelector<HTMLElement>(".markdown-table")!;
  const viewport = owner.querySelector<HTMLElement>(".markdown-table__viewport")!;
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 100 },
    scrollLeft: { configurable: true, value: 0, writable: true },
    scrollWidth: { configurable: true, value: 300 },
  });
  owner.addEventListener("click", handleMarkdownTableInteraction);
  enhanceMarkdownTables(owner);
  return { owner, shell, viewport };
}

// jsdom's pretendToBeVisual drives a real animation-frame loop, so tests that do
// not care about scheduling let it run. Tests that assert on coalescing or
// cancellation install a queue-only mock and step it by hand. The mock must stay
// asynchronous: production stores the id via `overflowSyncFrame ??=
// requestAnimationFrame(...)`, so a synchronous callback would run before the id
// is assigned and strand a handle that no later flush can reach.
const pendingAnimationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 0;

function installDeferredAnimationFrames(): void {
  pendingAnimationFrames.clear();
  nextAnimationFrameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextAnimationFrameId += 1;
    pendingAnimationFrames.set(nextAnimationFrameId, callback);
    return nextAnimationFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    pendingAnimationFrames.delete(id);
  });
}

function flushTableOverflowFrames(): void {
  const frames = [...pendingAnimationFrames.values()];
  pendingAnimationFrames.clear();
  for (const callback of frames) {
    callback(0);
  }
}

describe("Markdown table interactions", () => {
  beforeEach(() => {
    TestMutationObserver.instances = [];
    TestResizeObserver.instances = [];
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    mutationObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
    resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    restoreDialogPolyfill = installDialogPolyfill();
    Object.defineProperty(globalThis, "MutationObserver", {
      configurable: true,
      writable: true,
      value: TestMutationObserver,
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: TestResizeObserver,
    });
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Drain any frame a test left queued so the module-level handle returns to
    // null instead of leaking into the next test.
    flushTableOverflowFrames();
    document.body.replaceChildren();
    restoreProperty(navigator, "clipboard", clipboardDescriptor);
    restoreProperty(globalThis, "MutationObserver", mutationObserverDescriptor);
    restoreProperty(globalThis, "ResizeObserver", resizeObserverDescriptor);
    vi.unstubAllGlobals();
    restoreDialogPolyfill();
  });

  it("composes table chrome with session links and progress markup", () => {
    const disabled = toSanitizedMarkdownHtml(markdown, {
      progressBars: true,
      sessionLinks: true,
    });
    const enabled = toSanitizedMarkdownHtml(markdown, {
      progressBars: true,
      sessionLinks: true,
      tableInteractions: "enabled",
    });

    expect(disabled).not.toContain("data-table-interactions");
    expect(enabled).toContain("data-table-interactions");
    expect(enabled).toContain('data-session-key="agent:main:dashboard:table"');
    expect(enabled).toContain('<progress value="3" max="7"></progress>');
  });

  it("tracks hidden columns in both scroll directions", () => {
    installDeferredAnimationFrames();
    const { shell, viewport } = interactiveOwner();
    flushTableOverflowFrames();

    expect(shell.classList.contains("markdown-table--can-scroll-left")).toBe(false);
    expect(shell.classList.contains("markdown-table--can-scroll-right")).toBe(true);

    viewport.scrollLeft = 100;
    viewport.dispatchEvent(new Event("scroll"));
    // Overflow reads are coalesced into one frame, so the scroll handler itself
    // must not flip the class. A synchronous pass fails this line.
    expect(shell.classList.contains("markdown-table--can-scroll-left")).toBe(false);
    flushTableOverflowFrames();
    expect(shell.classList.contains("markdown-table--can-scroll-left")).toBe(true);
    expect(shell.classList.contains("markdown-table--can-scroll-right")).toBe(true);

    viewport.scrollLeft = 200;
    viewport.dispatchEvent(new Event("scroll"));
    flushTableOverflowFrames();
    expect(shell.classList.contains("markdown-table--can-scroll-left")).toBe(true);
    expect(shell.classList.contains("markdown-table--can-scroll-right")).toBe(false);
  });

  it("coalesces several tables into a single scheduled frame", () => {
    installDeferredAnimationFrames();
    interactiveOwner();
    expect(pendingAnimationFrames.size).toBe(1);

    interactiveOwner();
    // A later owner must not schedule a second frame while one is pending.
    expect(pendingAnimationFrames.size).toBe(1);
  });

  it("cancels the queued overflow frame when its owner is released", () => {
    installDeferredAnimationFrames();
    const { owner, viewport } = interactiveOwner();
    flushTableOverflowFrames();

    viewport.scrollLeft = 100;
    viewport.dispatchEvent(new Event("scroll"));
    expect(pendingAnimationFrames.size).toBe(1);

    releaseMarkdownTables(owner);
    // The module-level handle must not outlive its owner, or no later owner
    // would ever schedule a frame again.
    expect(pendingAnimationFrames.size).toBe(0);
  });

  it("schedules a fresh frame for a new owner after the previous one was released", () => {
    installDeferredAnimationFrames();
    const { owner, viewport } = interactiveOwner();
    flushTableOverflowFrames();

    viewport.scrollLeft = 100;
    viewport.dispatchEvent(new Event("scroll"));
    expect(pendingAnimationFrames.size).toBe(1);

    releaseMarkdownTables(owner);
    expect(pendingAnimationFrames.size).toBe(0);

    // Dropping the queue entries is not enough: the module-level frame handle
    // must be null too. A cancelled-but-still-set id makes `??=` skip the
    // request, so this owner's overflow would never be measured and the classes
    // would stay stale.
    interactiveOwner();
    expect(pendingAnimationFrames.size).toBe(1);
  });

  it("measures every table before writing the first overflow class", () => {
    installDeferredAnimationFrames();
    const { owner } = interactiveOwner(
      `${markdown}\n\n| Other | Value |\n| --- | --- |\n| Beta | Two |`,
    );
    const shells = [...owner.querySelectorAll<HTMLElement>(".markdown-table")];
    expect(shells).toHaveLength(2);

    const events: string[] = [];
    shells.forEach((shell, index) => {
      const viewport = shell.querySelector<HTMLElement>(".markdown-table__viewport")!;
      Object.defineProperties(viewport, {
        clientWidth: { configurable: true, value: 100 },
        scrollLeft: { configurable: true, value: 0, writable: true },
        scrollWidth: { configurable: true, value: 300 },
      });
      for (const property of ["clientWidth", "scrollWidth", "scrollLeft"] as const) {
        const value = viewport[property];
        Object.defineProperty(viewport, property, {
          configurable: true,
          get() {
            events.push(`${index}:read`);
            return value;
          },
        });
      }
      const classList = shell.classList as unknown as {
        toggle: (token: string, force?: boolean) => boolean;
      };
      const realToggle = classList.toggle.bind(classList);
      classList.toggle = (token: string, force?: boolean) => {
        events.push(`${index}:write`);
        return realToggle(token, force);
      };
    });

    flushTableOverflowFrames();

    // Both tables must actually have been measured, so the ordering assertion
    // below cannot pass just because nothing ran.
    expect(events.some((event) => event === "0:read")).toBe(true);
    expect(events.some((event) => event === "1:read")).toBe(true);

    const firstWrite = events.findIndex((event) => event.endsWith(":write"));
    expect(firstWrite).toBeGreaterThan(-1);
    // Toggling a class invalidates layout, so measuring any table after writing
    // a sibling's class would force one reflow per table in the burst.
    expect(events.slice(firstWrite).some((event) => event.endsWith(":read"))).toBe(false);
  });

  it("copies TSV and updates the copy label", async () => {
    vi.useFakeTimers();
    const { owner } = interactiveOwner();
    const copy = owner.querySelector<HTMLButtonElement>(".markdown-table__copy")!;
    copy.click();

    expect(writeText).toHaveBeenCalledWith("Name\tValue\nAlpha\tOne");
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.getAttribute("aria-label")).toBe("Copied!");
    expect(copy.querySelector("svg path")?.getAttribute("d")).toBe("M20 6 9 17l-5-5");
    await vi.advanceTimersByTimeAsync(1500);
    expect(copy.getAttribute("aria-label")).toBe("Copy table");
    expect(copy.querySelector("svg rect")).not.toBeNull();
  });

  it.each([true, false])(
    "shows a failed current table copy without stale success (previous success: %s)",
    async (previousSuccess) => {
      vi.useFakeTimers();
      const execDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
      const legacyCopy = vi.fn(() => false);
      Object.defineProperty(document, "execCommand", { configurable: true, value: legacyCopy });
      try {
        const { owner } = interactiveOwner();
        const copy = owner.querySelector<HTMLButtonElement>(".markdown-table__copy")!;
        if (previousSuccess) {
          copy.click();
          await vi.advanceTimersByTimeAsync(0);
          expect(copy.getAttribute("aria-label")).toBe("Copied!");
          expect(copy.querySelector("svg path")?.getAttribute("d")).toBe("M20 6 9 17l-5-5");
        }

        writeText.mockRejectedValueOnce(
          new DOMException("Clipboard access denied", "NotAllowedError"),
        );
        copy.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(writeText).toHaveBeenLastCalledWith("Name\tValue\nAlpha\tOne");
        expect(legacyCopy).toHaveBeenCalledExactlyOnceWith("copy");
        expect(copy.getAttribute("aria-label")).toBe("Copy failed");
        expect(copy.querySelector("svg rect")).not.toBeNull();
        await vi.advanceTimersByTimeAsync(1500);
        expect(copy.getAttribute("aria-label")).toBe("Copy failed");

        copy.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(copy.getAttribute("aria-label")).toBe("Copied!");
        expect(copy.querySelector("svg path")?.getAttribute("d")).toBe("M20 6 9 17l-5-5");
        await vi.advanceTimersByTimeAsync(500);
        expect(copy.getAttribute("aria-label")).toBe("Copied!");
        await vi.advanceTimersByTimeAsync(1000);
        expect(copy.getAttribute("aria-label")).toBe("Copy table");
        expect(copy.querySelector("svg rect")).not.toBeNull();
      } finally {
        restoreProperty(document, "execCommand", execDescriptor);
      }
    },
  );

  it("restores focus after the table dialog closes", async () => {
    const { owner } = interactiveOwner();
    const expand = owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!;
    expand.focus();
    expand.click();
    expand.click();

    const { dialog, modal } = await waitForRenderedModalDialog(owner);
    expect(owner.querySelectorAll(".markdown-table-modal")).toHaveLength(1);
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(modal.querySelector("table")?.textContent).toContain("Alpha");
    dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.querySelector(".markdown-table-dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);

    expand.click();
    const reopened = await waitForRenderedModalDialog(owner);
    reopened.modal.querySelector<HTMLButtonElement>(".markdown-table-dialog__close")!.click();
    expect(document.querySelector(".markdown-table-dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
  });

  it("cancels a pending expansion when its owner disconnects and reconnects", async () => {
    const { owner } = interactiveOwner(
      `${markdown}\n\n| Updated | Value |\n| --- | --- |\n| Beta | Two |`,
    );
    const [first, second] = owner.querySelectorAll<HTMLButtonElement>(".markdown-table__expand");
    first!.click();

    releaseMarkdownTables(owner);
    owner.remove();
    document.body.append(owner);
    enhanceMarkdownTables(owner);
    second!.focus();
    second!.click();

    const { modal } = await waitForRenderedModalDialog(owner);
    expect(owner.querySelectorAll(".markdown-table-modal")).toHaveLength(1);
    expect(modal.querySelector("table")?.textContent).toContain("Beta");
    modal.querySelector<HTMLButtonElement>(".markdown-table-dialog__close")!.click();
    expect(document.activeElement).toBe(second);
  });

  it.each([true, false])(
    "dismisses middle-clicks while preserving right-click menus (browser panel: %s)",
    async (openInBrowserPanel) => {
      const routing = startNativeLinkRouting({
        shouldOpenInControlUiBrowser: () => openInBrowserPanel,
      });
      const { owner } = interactiveOwner(
        "| Reference |\n| --- |\n| [Open reference](https://example.com/table) |",
      );
      try {
        owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!.click();
        const { modal } = await waitForRenderedModalDialog(owner);
        const link = modal.querySelector("a")!;
        vi.useFakeTimers();
        for (const type of ["contextmenu", "auxclick"]) {
          const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 2 });
          link.dispatchEvent(event);
          await vi.advanceTimersByTimeAsync(0);
          expect(event.defaultPrevented).toBe(false);
          expect(modal.isConnected).toBe(true);
        }
        const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
        link.dispatchEvent(middle);
        expect(middle.defaultPrevented).toBe(openInBrowserPanel);
        await vi.advanceTimersByTimeAsync(0);
        expect(modal.isConnected).toBe(false);
      } finally {
        routing.dispose();
        releaseMarkdownTables(owner);
      }
    },
  );

  it("retires a connected pane's pending table without blocking another pane", async () => {
    const pane = document.createElement("section");
    const { owner } = interactiveOwner();
    pane.append(owner);
    document.body.append(pane);
    owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!.click();

    resetTranscriptSession("retired-pane", pane);
    await vi.dynamicImportSettled();
    expect(owner.isConnected).toBe(true);
    expect(owner.querySelector(".markdown-table-modal")).toBeNull();

    const { owner: current } = interactiveOwner();
    current.querySelector<HTMLButtonElement>(".markdown-table__expand")!.click();
    const { modal } = await waitForRenderedModalDialog(current);
    expect(modal.querySelector("table")?.textContent).toContain("Alpha");
    releaseMarkdownTables(current);
  });

  it("disconnects observers and removes the dialog with its transcript owner", async () => {
    const { owner } = interactiveOwner();
    const mutation = TestMutationObserver.instances.at(-1)!;
    const resize = TestResizeObserver.instances.at(-1)!;
    owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!.click();
    const { dialog } = await waitForRenderedModalDialog(owner);

    releaseMarkdownTables(owner);
    owner.remove();

    expect(mutation.disconnect).toHaveBeenCalledOnce();
    expect(resize.disconnect).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);
    expect(document.querySelector(".markdown-table-dialog")).toBeNull();
  });
});

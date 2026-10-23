/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNativeLinkRouting } from "../app/native-link-routing.ts";
import {
  registerTranscriptElement,
  resetThreadPresentation,
  resetTranscriptSession,
} from "../pages/chat/components/chat-thread-interactions.ts";
import { installDialogPolyfill, waitForRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import {
  enhanceMarkdownTables,
  handleMarkdownTableInteraction,
  releaseMarkdownTables,
} from "./markdown-tables.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { SessionLinkTitler } from "./session-link-titling.ts";
import { installSessionTitleRegistrar } from "./session-title-target-registration.ts";

const writeText = vi.fn(async (_text: string) => undefined);

let originalMutationObserver: typeof MutationObserver;
let restoreDialogPolyfill: () => void;
const restoreProperties: Array<() => void> = [];

function stubProperty(target: object, key: PropertyKey, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  restoreProperties.push(() =>
    descriptor
      ? Object.defineProperty(target, key, descriptor)
      : Reflect.deleteProperty(target, key),
  );
  Object.defineProperty(target, key, { configurable: true, value });
}

const table = "| Name | Value |\n| --- | --- |\n| Alpha | One |";
const markdown = `Open agent:main:dashboard:table\n\n<progress value="3" max="7"></progress>\n\n${table}`;

const MutationObserverMock = vi.fn(function (_callback: MutationCallback) {
  return { disconnect: vi.fn(), observe: vi.fn() };
});
const ResizeObserverMock = vi.fn(function (
  _callback: (entries: Pick<ResizeObserverEntry, "target">[]) => void,
) {
  return { disconnect: vi.fn(), observe: vi.fn(), unobserve: vi.fn() };
});

function deliverTableResize(target: HTMLElement): void {
  ResizeObserverMock.mock.calls.at(-1)?.[0]([{ target }]);
}

const renderOptions = { progressBars: true, sessionLinks: true };
const interactiveOptions = { ...renderOptions, tableInteractions: "enabled" as const };
function query(owner: ParentNode, selector: string): HTMLElement {
  return owner.querySelector<HTMLElement>(selector)!;
}

function interactiveOwner(content = table) {
  const owner = document.createElement("div");
  owner.className = "chat-thread";
  owner.innerHTML = `<div class="chat-text">${toSanitizedMarkdownHtml(content, interactiveOptions)}</div>`;
  document.body.append(owner);
  const shell = query(owner, ".markdown-table");
  const viewport = query(owner, ".markdown-table__viewport");
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 100 },
    scrollLeft: { configurable: true, value: 0, writable: true },
    scrollWidth: { configurable: true, value: 300 },
  });
  owner.addEventListener("click", handleMarkdownTableInteraction);
  enhanceMarkdownTables(owner);
  deliverTableResize(viewport);
  return {
    owner,
    shell,
    viewport,
    expand: owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!,
    copy: owner.querySelector<HTMLButtonElement>(".markdown-table__copy")!,
  };
}

async function openTable(owner: HTMLElement) {
  owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!.click();
  return waitForRenderedModalDialog(owner);
}

async function copyTable(copy: HTMLButtonElement, label: string) {
  copy.click();
  await vi.advanceTimersByTimeAsync(0);
  expectCopy(copy, label);
}
function expectCopy(copy: HTMLButtonElement, label: string) {
  expect(copy.getAttribute("aria-label")).toBe(label);
  if (label === "Copied!") {
    expect(copy.querySelector("svg path")?.getAttribute("d")).toBe("M20 6 9 17l-5-5");
  } else {
    expect(copy.querySelector("svg rect")).not.toBeNull();
  }
}

describe("Markdown table interactions", () => {
  beforeEach(() => {
    MutationObserverMock.mockClear();
    ResizeObserverMock.mockClear();
    originalMutationObserver = MutationObserver;
    restoreDialogPolyfill = installDialogPolyfill();
    vi.stubGlobal("MutationObserver", MutationObserverMock);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    writeText.mockClear();
    stubProperty(navigator, "clipboard", { writeText });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetThreadPresentation();
    document.body.replaceChildren();
    restoreProperties
      .splice(0)
      .toReversed()
      .forEach((restore) => restore());
    vi.unstubAllGlobals();
    restoreDialogPolyfill();
  });

  it("composes table chrome with session links and progress markup", () => {
    const disabled = toSanitizedMarkdownHtml(markdown, renderOptions);
    const enabled = toSanitizedMarkdownHtml(markdown, interactiveOptions);
    expect(disabled).not.toContain("data-table-interactions");
    expect(enabled).toContain("data-table-interactions");
    expect(enabled).toContain('data-session-key="agent:main:dashboard:table"');
    expect(enabled).toContain('<progress value="3" max="7"></progress>');
  });

  it("tracks hidden columns in both scroll directions", () => {
    const { shell, viewport } = interactiveOwner();
    const canScroll = (side: string) =>
      shell.classList.contains(`markdown-table--can-scroll-${side}`);
    for (const [offset, left, right] of [
      [0, false, true],
      [100, true, true],
      [200, true, false],
    ] as const) {
      viewport.scrollLeft = offset;
      if (offset) {
        viewport.dispatchEvent(new Event("scroll"));
      }
      expect([canScroll("left"), canScroll("right")]).toEqual([left, right]);
    }
  });

  it("updates retained table overflow without mutation-time layout", async () => {
    vi.stubGlobal("MutationObserver", originalMutationObserver);
    const { owner, shell, viewport } = interactiveOwner(`${table}\n\n${table}`);
    const otherViewport = owner.querySelectorAll(".markdown-table__viewport")[1]!;
    const otherWidth = vi.fn(() => 300);
    const changedWidth = vi.fn(() => 100);
    Object.defineProperty(otherViewport, "scrollWidth", { configurable: true, get: otherWidth });
    Object.defineProperty(viewport, "scrollWidth", { configurable: true, get: changedWidth });

    try {
      shell.querySelector("td")!.firstChild!.textContent = "Shorter";
      await Promise.resolve();
      await Promise.resolve();
      expect(changedWidth).not.toHaveBeenCalled();
      expect(otherWidth).not.toHaveBeenCalled();
      deliverTableResize(viewport);
      expect(shell.classList.contains("markdown-table--can-scroll-right")).toBe(false);
      expect(changedWidth).toHaveBeenCalled();
      expect(otherWidth).not.toHaveBeenCalled();

      changedWidth.mockClear();
      query(shell, ".markdown-table__copy").replaceChildren(document.createElement("span"));
      await Promise.resolve();
      await Promise.resolve();
      expect(changedWidth).not.toHaveBeenCalled();
      expect(otherWidth).not.toHaveBeenCalled();
    } finally {
      releaseMarkdownTables(owner);
    }
  });

  it("shows a failed current table copy without stale success", async () => {
    vi.useFakeTimers();
    const legacyCopy = vi.fn(() => false);
    stubProperty(document, "execCommand", legacyCopy);
    const { copy } = interactiveOwner();
    await copyTable(copy, "Copied!");

    writeText.mockRejectedValueOnce(new DOMException("Clipboard access denied", "NotAllowedError"));
    await copyTable(copy, "Copy failed");

    expect(writeText).toHaveBeenLastCalledWith("Name\tValue\nAlpha\tOne");
    expect(legacyCopy).toHaveBeenCalledExactlyOnceWith("copy");
    await vi.advanceTimersByTimeAsync(1500);
    expect(copy.getAttribute("aria-label")).toBe("Copy failed");

    await copyTable(copy, "Copied!");
    await vi.advanceTimersByTimeAsync(500);
    expect(copy.getAttribute("aria-label")).toBe("Copied!");
    await vi.advanceTimersByTimeAsync(1000);
    expectCopy(copy, "Copy table");
  });

  it("announces table copy outcomes in a status region", async () => {
    vi.useFakeTimers();
    stubProperty(
      document,
      "execCommand",
      vi.fn(() => false),
    );
    const { shell, copy } = interactiveOwner();
    const statusText = () => shell.querySelector('[role="status"]')?.textContent;
    await copyTable(copy, "Copied!");
    expect(statusText()).toBe("Copied!");

    writeText.mockRejectedValueOnce(new DOMException("Clipboard access denied", "NotAllowedError"));
    await copyTable(copy, "Copy failed");
    expect(statusText()).toBe("Copy failed");
    await vi.advanceTimersByTimeAsync(2000);
    expect(statusText()).toBe("");
  });

  it("decorates cloned session links and retires their registrations on close", async () => {
    const titler = new SessionLinkTitler();
    installSessionTitleRegistrar((target, label) => titler.register(target, label));
    const { owner } = interactiveOwner("| Task |\n| --- |\n| agent:main:research |");
    const source = owner.querySelector<HTMLAnchorElement>("a.markdown-session-link")!;
    expect(source.hasAttribute("href")).toBe(false);

    try {
      const { modal } = await openTable(owner);
      const clone = modal.querySelector<HTMLAnchorElement>("a.markdown-session-link")!;
      expect(clone).not.toBe(source);
      await expect.poll(() => clone.getAttribute("href")).toBe("/chat/main/research");

      modal.querySelector<HTMLButtonElement>(".markdown-table-dialog__close")!.click();
      expect(modal.isConnected).toBe(false);
      clone.removeAttribute("href");
      titler.refresh();
      await Promise.resolve();
      expect(clone.hasAttribute("href")).toBe(false);
    } finally {
      titler.disconnect();
      releaseMarkdownTables(owner);
    }
  });

  it("cancels a pending expansion when its owner disconnects and reconnects", async () => {
    const updated = "| Updated | Value |\n| --- | --- |\n| Beta | Two |";
    const { owner } = interactiveOwner(`${table}\n\n${updated}`);
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
    await Promise.resolve();
    expect(document.querySelector(".markdown-table-dialog")).toBeNull();
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
        const { modal } = await openTable(owner);
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
    const { owner, expand } = interactiveOwner();
    pane.append(owner);
    document.body.append(pane);
    registerTranscriptElement("retired-pane", owner);
    expand.click();

    resetTranscriptSession("retired-pane", pane);
    await vi.dynamicImportSettled();
    expect(owner.isConnected).toBe(true);
    expect(owner.querySelector(".markdown-table-modal")).toBeNull();

    const { owner: current } = interactiveOwner();
    const { modal } = await openTable(current);
    expect(modal.querySelector("table")?.textContent).toContain("Alpha");
    releaseMarkdownTables(current);
  });

  it("disconnects observers and removes the dialog with its transcript owner", async () => {
    const { owner } = interactiveOwner();
    const mutation = MutationObserverMock.mock.results.findLast(
      (result) => result.type === "return",
    )!.value;
    const resize = ResizeObserverMock.mock.results.findLast(
      (result) => result.type === "return",
    )!.value;
    const { dialog } = await openTable(owner);

    releaseMarkdownTables(owner);
    owner.remove();

    expect(mutation.disconnect).toHaveBeenCalledOnce();
    expect(resize.disconnect).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);
    expect(document.querySelector(".markdown-table-dialog")).toBeNull();
  });
});

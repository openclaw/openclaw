/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawFilePreviewModal } from "./file-preview-modal.ts";
import "./file-preview-modal.ts";

let container: HTMLDivElement;

const files = [
  {
    path: "templates/digest.md",
    size: "2.1 KB",
    contents: "Morning digest template",
  },
  {
    path: "filters/auto-senders.txt",
    size: "418 B",
    contents: "noreply@example.com",
  },
];

type RenderPreviewOptions = {
  query?: string;
  activePath?: string;
  previewFiles?: typeof files;
};

async function renderPreview(options: RenderPreviewOptions = {}) {
  const query = options.query ?? "";
  const activePath = options.activePath ?? "templates/digest.md";
  const previewFiles = options.previewFiles ?? files;
  render(
    html`
      <openclaw-file-preview-modal
        .files=${previewFiles}
        .activePath=${activePath}
        .query=${query}
        .contextLabel=${"in morning-catchup"}
      ></openclaw-file-preview-modal>
    `,
    container,
  );

  const modal = container.querySelector<OpenClawFilePreviewModal>("openclaw-file-preview-modal");
  expect(modal).toBeInstanceOf(HTMLElement);
  if (!modal) {
    throw new Error("expected file preview modal");
  }
  await modal.updateComplete;
  await modal.updateComplete;
  return modal;
}

function shadowText(modal: OpenClawFilePreviewModal): string {
  return modal.shadowRoot?.textContent ?? "";
}

describe("openclaw-file-preview-modal", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    vi.restoreAllMocks();
  });

  it("filters files by path or contents", async () => {
    const modal = await renderPreview({ query: "sender" });

    expect(shadowText(modal)).toContain("1/2 files");
    expect(shadowText(modal)).toContain("filters/auto-senders.txt");
    expect(shadowText(modal)).not.toContain("templates/digest.md");
    expect(shadowText(modal)).toContain("noreply@example.com");
  });

  it("shows the Escape shortcut only on the close button", async () => {
    const modal = await renderPreview();
    const state = modal.shadowRoot?.querySelector<HTMLElement>(".state");
    const closeButton = modal.shadowRoot?.querySelector<HTMLButtonElement>(".button");

    expect(state?.textContent?.trim()).toBe("2 files");
    expect(state?.querySelector(".kbd")).toBeNull();
    expect(closeButton?.textContent?.replace(/\s+/g, " ").trim()).toBe("Close esc");
    expect(closeButton?.querySelector(".kbd")?.textContent).toBe("esc");
  });

  it("emits controlled query, select, and close events", async () => {
    const modal = await renderPreview();
    const onQuery = vi.fn();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    modal.addEventListener("file-preview-query-change", onQuery);
    modal.addEventListener("file-preview-select", onSelect);
    modal.addEventListener("file-preview-close", onClose);

    const input = modal.shadowRoot?.querySelector<HTMLInputElement>(".search");
    expect(input).toBeInstanceOf(HTMLInputElement);
    input!.value = "digest";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));

    const secondFile = modal.shadowRoot?.querySelectorAll<HTMLButtonElement>(".item")[1];
    expect(secondFile).toBeInstanceOf(HTMLButtonElement);
    secondFile!.click();

    modal.shadowRoot
      ?.querySelector<HTMLElement>(".modal")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(onQuery.mock.lastCall?.[0].detail).toBe("digest");
    expect(onSelect.mock.lastCall?.[0].detail).toBe("filters/auto-senders.txt");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps keyboard focus in the modal and navigates files with arrow keys", async () => {
    const modal = await renderPreview();
    const onSelect = vi.fn();
    const onDocumentKeydown = vi.fn();
    modal.addEventListener("file-preview-select", onSelect);
    document.addEventListener("keydown", onDocumentKeydown);

    const input = modal.shadowRoot?.querySelector<HTMLInputElement>(".search");
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(modal.shadowRoot?.activeElement).toBe(input);

    const arrowDown = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input!.dispatchEvent(arrowDown);

    expect(arrowDown.defaultPrevented).toBe(true);
    expect(onDocumentKeydown).not.toHaveBeenCalled();
    expect(onSelect.mock.lastCall?.[0].detail).toBe("filters/auto-senders.txt");
  });

  it("blocks background arrow-key scrolling even when no files match", async () => {
    const modal = await renderPreview({ query: "missing" });
    const onDocumentKeydown = vi.fn();
    document.addEventListener("keydown", onDocumentKeydown);

    const input = modal.shadowRoot?.querySelector<HTMLInputElement>(".search");
    const arrowDown = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input!.dispatchEvent(arrowDown);

    expect(arrowDown.defaultPrevented).toBe(true);
    expect(onDocumentKeydown).not.toHaveBeenCalled();
  });

  it("keeps large-file rendering bounded and resets the real scroller on file changes", async () => {
    let frameCallback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const firstContents = Array.from({ length: 500 }, (_, index) => `first-${index}`).join("\n");
    const secondContents = Array.from({ length: 500 }, (_, index) => `second-${index}`).join("\n");
    const previewFiles = [
      { path: "first.ts", size: "5 KB", contents: firstContents },
      { path: "second.ts", size: "5 KB", contents: secondContents },
    ];
    const modal = await renderPreview({ activePath: "first.ts", previewFiles });
    const body = modal.shadowRoot?.querySelector<HTMLElement>(".detail-body");
    expect(body).toBeInstanceOf(HTMLElement);
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 220 });

    body!.scrollTop = 2200;
    body!.dispatchEvent(new Event("scroll"));
    frameCallback?.(0);
    await modal.updateComplete;

    const scrolledLines = modal.shadowRoot?.querySelectorAll<HTMLElement>(".code-line") ?? [];
    expect(scrolledLines.length).toBeLessThanOrEqual(70);
    expect(scrolledLines[0]?.dataset.line).toBe("70");
    expect(scrolledLines[0]?.textContent).toBe("first-70");

    const updatedModal = await renderPreview({ activePath: "second.ts", previewFiles });
    const updatedBody = updatedModal.shadowRoot?.querySelector<HTMLElement>(".detail-body");
    const updatedLines = updatedModal.shadowRoot?.querySelectorAll<HTMLElement>(".code-line") ?? [];

    expect(updatedBody?.scrollTop).toBe(0);
    expect(updatedLines[0]?.dataset.line).toBe("0");
    expect(updatedLines[0]?.textContent).toBe("second-0");
  });

  it("observes the current scroller after an empty filter replaces it", async () => {
    const observedTargets: Element[] = [];
    const disconnect = vi.fn();
    class TestResizeObserver {
      observe(target: Element) {
        observedTargets.push(target);
      }
      unobserve() {}
      disconnect = disconnect;
      takeRecords(): ResizeObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    const modal = await renderPreview();
    const initialBody = modal.shadowRoot?.querySelector<HTMLElement>(".detail-body");
    expect(initialBody).toBeInstanceOf(HTMLElement);
    expect(observedTargets).toContain(initialBody);

    await renderPreview({ query: "missing" });
    expect(modal.shadowRoot?.querySelector(".detail-body")).toBeNull();
    expect(disconnect).toHaveBeenCalled();

    const restoredModal = await renderPreview();
    const restoredBody = restoredModal.shadowRoot?.querySelector<HTMLElement>(".detail-body");
    expect(restoredBody).toBeInstanceOf(HTMLElement);
    expect(restoredBody).not.toBe(initialBody);
    expect(observedTargets).toContain(restoredBody);
  });

  it("copies the complete active file while only a virtual window is rendered", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const contents = Array.from({ length: 500 }, (_, index) => `line-${index}`).join("\n");
    const previewFiles = [{ path: "large.ts", size: "5 KB", contents }];
    const modal = await renderPreview({ activePath: "large.ts", previewFiles });
    const copyButton = modal.shadowRoot?.querySelector<HTMLButtonElement>(".chat-copy-btn");

    expect(copyButton).toBeInstanceOf(HTMLButtonElement);
    expect(modal.shadowRoot?.querySelectorAll(".code-line").length).toBeLessThan(500);
    copyButton!.click();

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(contents);
      expect(copyButton?.dataset.copied).toBe("1");
    });
  });
});

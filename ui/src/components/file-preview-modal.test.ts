/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import "./file-preview-modal-registration.ts";
import { Icon } from "./solid/icon.tsx";

type FilePreviewModalElement = HTMLElementTagNameMap["openclaw-file-preview-modal"];

let container: HTMLDivElement;

const files = [
  { path: "templates/digest.md", size: "2.1 KB", contents: "Morning digest template" },
  { path: "filters/auto-senders.txt", size: "418 B", contents: "noreply@example.com" },
];

type RenderPreviewOptions = {
  query?: string;
  activePath?: string;
  previewFiles?: FilePreviewModalElement["files"];
  layout?: "files" | "document";
};

async function renderPreview(options: RenderPreviewOptions = {}) {
  const modal = Object.assign(document.createElement("openclaw-file-preview-modal"), {
    files: options.previewFiles ?? files,
    activePath: options.activePath ?? files[0]!.path,
    query: options.query ?? "",
    contextLabel: "in morning-catchup",
    layout: options.layout ?? "files",
  });
  mountSolid(() => modal, { container });

  await modal.updateComplete;
  flush();
  return modal;
}

function pressArrowDown(target: EventTarget | null | undefined) {
  const event = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target?.dispatchEvent(event);
  return event;
}

describe("openclaw-file-preview-modal", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    await i18n.setLocale("en");
    container.replaceChildren();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it("uses the composer skill glyph for skill files but keeps ordinary Markdown icons", async () => {
    const modal = await renderPreview({
      activePath: "SKILL.md",
      previewFiles: [
        { path: "SKILL.md", size: "1 KB", contents: "Skill instructions" },
        { path: "README.md", size: "1 KB", contents: "Documentation" },
      ],
    });
    const reference = document.createElement("div");
    mountSolid(() => createComponent(Icon, { name: "pencilSparkles" }), { container: reference });
    const paths = (element: Element | null | undefined) =>
      [...(element?.querySelectorAll("path") ?? [])].map((path) => path.getAttribute("d"));
    const expectedIcon = paths(reference.querySelector("svg"));
    const skillIcon = modal.querySelector('[data-path="SKILL.md"] .item-icon svg');
    const markdownIcon = modal.querySelector('[data-path="README.md"] .item-icon svg');
    expect(paths(skillIcon)).toEqual(expectedIcon);
    expect(paths(markdownIcon)).not.toEqual(expectedIcon);
  });

  it("emits controlled query, select, and close events", async () => {
    const modal = await renderPreview();
    const actions = modal.querySelector(".foot > openclaw-modal-actions");
    expect(actions?.querySelector("button")).not.toBeNull();
    expect(actions?.parentElement?.lastElementChild).toBe(actions);
    expect(actions?.querySelector(".foot-group")).toBeNull();
    expect(modal.querySelector(".foot > .foot-group")).not.toBeNull();
    const onQuery = vi.fn();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    modal.addEventListener("file-preview-query-change", onQuery);
    modal.addEventListener("file-preview-select", onSelect);
    modal.addEventListener("file-preview-close", onClose);

    const input = modal.querySelector<HTMLInputElement>(".search");
    expect(input).toBeInstanceOf(HTMLInputElement);
    input!.value = "digest";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));

    const secondFile = modal.querySelectorAll<HTMLButtonElement>(".item")[1];
    expect(secondFile).toBeInstanceOf(HTMLButtonElement);
    secondFile!.click();

    modal
      .querySelector<HTMLElement>(".modal")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(onQuery.mock.lastCall?.[0].detail).toBe("digest");
    expect(onSelect.mock.lastCall?.[0].detail).toBe("filters/auto-senders.txt");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(["files", "document"] as const)(
    "updates the active %s preview and focus without untracked reads",
    async (layout) => {
      const warning = vi.spyOn(console, "warn");
      const modal = await renderPreview({ layout });
      modal.activePath = files[1]!.path;
      await modal.updateComplete;

      expect(modal.querySelector(".detail-body")?.textContent).toContain("noreply@example.com");
      expect(document.activeElement).toBe(
        modal.querySelector(layout === "files" ? ".search" : ".item.is-active"),
      );
      expect(warning.mock.calls.flat().join(" ")).not.toContain("STRICT_READ_UNTRACKED");
    },
  );

  it("reveals active rows on list updates and only refocuses changed document paths", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const modal = await renderPreview();
    const focusTarget = modal.querySelector<HTMLElement>(".modal")!;
    focusTarget.tabIndex = 0;
    focusTarget.focus();

    for (const patch of [
      { query: "digest" },
      { files: files.map((file) => ({ ...file, size: "3 KB" })) },
      { layout: "document" as const },
      { activePath: files[1]!.path },
    ]) {
      scroll.mockClear();
      Object.assign(modal, patch);
      await modal.updateComplete;
      const active = modal.querySelector(".item.is-active");
      expect(scroll.mock.contexts.at(-1)).toBe(active);
      expect(document.activeElement).toBe("activePath" in patch ? active : focusTarget);
    }
  });

  it("restores modal focus when the same element reconnects", async () => {
    const modal = await renderPreview();
    const outside = document.createElement("button");
    document.body.append(outside);

    try {
      container.remove();
      await Promise.resolve();
      outside.focus();
      expect(document.activeElement).toBe(outside);
      document.body.append(container);
      await modal.updateComplete;

      const input = modal.querySelector<HTMLInputElement>(".search");
      expect(input).toBeInstanceOf(HTMLInputElement);
      expect(document.activeElement).toBe(input);
    } finally {
      outside.remove();
    }
  });

  it("blocks background arrow-key scrolling even when no files match", async () => {
    const modal = await renderPreview({ query: "missing" });
    const onDocumentKeydown = vi.fn();
    document.addEventListener("keydown", onDocumentKeydown);

    const input = modal.querySelector<HTMLInputElement>(".search");
    const arrowDown = pressArrowDown(input);

    expect(arrowDown.defaultPrevented).toBe(true);
    expect(onDocumentKeydown).not.toHaveBeenCalled();
  });

  it("chunks large files without changing their text and resets the scroller on file changes", async () => {
    const previewFiles = ["first", "second"].map((name) => ({
      path: `${name}.ts`,
      size: "5 KB",
      contents: Array.from({ length: 500 }, (_, index) => `${name}-${index}`).join("\n"),
    }));
    const [firstContents, secondContents] = previewFiles.map((file) => file.contents);
    const modal = await renderPreview({ activePath: "first.ts", previewFiles });
    const body = modal.querySelector<HTMLElement>(".detail-body");
    expect(body).toBeInstanceOf(HTMLElement);
    const firstChunks = [...(modal.querySelectorAll<HTMLElement>(".code-chunk") ?? [])];
    expect(firstChunks).toHaveLength(8);
    expect(firstChunks.map((chunk) => chunk.textContent ?? "").join("\n")).toBe(firstContents);

    body!.scrollTop = 2200;
    body!.scrollLeft = 40;
    expect(body!.scrollTop).toBe(2200);

    modal.activePath = "second.ts";
    await modal.updateComplete;
    const updatedBody = modal.querySelector<HTMLElement>(".detail-body");
    const secondChunks = [...(modal.querySelectorAll<HTMLElement>(".code-chunk") ?? [])];

    expect(updatedBody).toMatchObject({ scrollTop: 0, scrollLeft: 0 });
    expect(secondChunks.map((chunk) => chunk.textContent ?? "").join("\n")).toBe(secondContents);

    updatedBody!.scrollTop = 320;
    updatedBody!.scrollLeft = 40;
    modal.files = previewFiles.map((file) =>
      file.path === "second.ts"
        ? Object.assign({}, file, { contents: `${file.contents}\nUpdated contents` })
        : file,
    );
    await modal.updateComplete;
    expect(modal.querySelector(".detail-body")).toMatchObject({ scrollTop: 0, scrollLeft: 0 });
  });

  it.each(["files", "document"] as const)(
    "keeps the current %s content and scroll position when a sibling file finishes loading",
    async (layout) => {
      const modal = await renderPreview({ layout });
      const body = modal.querySelector<HTMLElement>(".detail-body")!;
      const content = body.querySelector(".markdown, .code-content")!;
      const first = content.firstElementChild;
      body.scrollTop = 240;
      body.scrollLeft = 40;

      modal.files = files.map((file) => ({
        path: file.path,
        size: file.size,
        contents: file.path === modal.activePath ? file.contents : "New sibling contents",
      }));
      await modal.updateComplete;

      expect(modal.querySelector(".detail-body")).toBe(body);
      expect(content.firstElementChild).toBe(first);
      expect(body).toMatchObject({ scrollTop: 240, scrollLeft: 40 });
      expect(body.textContent).toContain("Morning digest template");

      // Changing the requested path still reveals a row, but an unchanged resolved file stays put.
      const reveal = vi.spyOn(Element.prototype, "scrollIntoView");
      modal.activePath = "missing-file.md";
      await modal.updateComplete;
      expect(reveal.mock.contexts.at(-1)).toBe(modal.querySelector(".item.is-active"));
      expect(body).toMatchObject({ scrollTop: 240, scrollLeft: 40 });
    },
  );

  it("navigates only expanded document folders and keeps relative Markdown links inside the preview", async () => {
    const modal = await renderPreview({
      layout: "document",
      activePath: "SKILL.md",
      previewFiles: [
        {
          path: "SKILL.md",
          size: "1 KB",
          contents: "---\nname: guide\n---\n# Guide\n[Notes](notes/a.md)",
        },
        { path: "hidden/a.md", size: "1 KB", contents: "Hidden notes" },
        { path: "notes/a.md", size: "1 KB", contents: "Visible notes" },
      ],
    });
    const select = vi.fn();
    modal.addEventListener("file-preview-select", select);
    const hidden = [...modal.querySelectorAll("details")].find(
      (folder) => folder.querySelector("summary")?.textContent === "hidden",
    )!;
    hidden.open = false;
    pressArrowDown(modal.querySelector(".item.is-active"));
    expect(select.mock.lastCall?.[0].detail).toBe("notes/a.md");
    expect(modal.querySelector(".markdown")?.textContent).not.toContain("name: guide");
    const link = modal.querySelector<HTMLAnchorElement>(".markdown a")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(select.mock.lastCall?.[0].detail).toBe("notes/a.md");
  });

  it.each([true, false])(
    "restores localized file-copy labels after pending success %s",
    async (copied) => {
      const write = createDeferred();
      const writeText = vi.fn(() => write.promise);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
      const schedule = vi.spyOn(window, "setTimeout");
      const modal = await renderPreview();
      const button = modal.querySelector<HTMLButtonElement>(".chat-copy-btn")!;
      button.click();
      expect(button.disabled).toBe(true);
      i18n.registerTranslation("pt-BR", {
        common: { close: "Fechar", copied: "Copiado!", copyFailed: "Falha ao copiar" },
        filePreview: {
          label: "Arquivos de suporte",
          copyFile: "Copiar arquivo",
          fileCount: "{count} arquivos",
        },
      });

      await i18n.setLocale("pt-BR");
      await modal.updateComplete;

      expect(
        modal.querySelector<HTMLElement & { label: string }>("openclaw-modal-dialog")?.label,
      ).toBe("Arquivos de suporte");
      expect(modal.textContent).toContain("2 arquivos");
      expect(modal.textContent).toContain("Fechar");
      expect(button.getAttribute("aria-label")).toBe("Copiar arquivo");
      if (copied) {
        write.resolve();
      } else {
        write.reject(new DOMException("Clipboard access denied"));
      }
      const feedback = modal.querySelector<HTMLElement>("[role=status]")!;
      await waitForSolid(() =>
        expect(feedback.textContent).toBe(copied ? "Copiado!" : "Falha ao copiar"),
      );
      expect(feedback.hidden).toBe(false);
      expect(button.getAttribute("aria-label")).toBe(feedback.textContent);
      expect(writeText).toHaveBeenCalledWith("Morning digest template");
      const reset = schedule.mock.calls.find(
        ([, delay]) => delay === (copied ? 1_500 : 2_000),
      )?.[0];
      if (typeof reset !== "function") {
        throw new Error("Expected copy feedback to schedule its reset");
      }
      reset();
      flush();
      expect(button.getAttribute("aria-label")).toBe("Copiar arquivo");
      expect(feedback.hidden).toBe(true);
    },
  );

  it.each([["references/notes.constructor", "CONSTRUCTOR"]])(
    "renders the fallback file-kind label for %s",
    async (path, label) => {
      const modal = await renderPreview({
        activePath: path,
        previewFiles: [{ path, size: "12 B", contents: "Example file" }],
      });

      expect(modal.querySelector(".chip.accent")?.textContent).toBe(label);
    },
  );
});

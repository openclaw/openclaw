/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import "./file-preview-modal-registration.ts";
import { Icon } from "./solid/icon.tsx";

type Preview = HTMLElementTagNameMap["openclaw-file-preview-modal"];

let container: HTMLDivElement;
const find = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector<T>(selector);
const findAll = <T extends Element = HTMLElement>(selector: string) =>
  Array.from(container.querySelectorAll<T>(selector));

const previewFile = (path: string, contents: string, size = "1 KB") => ({ path, size, contents });
const files = [
  previewFile("templates/digest.md", "Morning digest template", "2.1 KB"),
  previewFile("filters/auto-senders.txt", "noreply@example.com", "418 B"),
];

type PreviewOptions = Partial<Pick<Preview, "query" | "activePath" | "files" | "layout">>;

async function renderPreview(options: PreviewOptions = {}) {
  const modal = document.createElement("openclaw-file-preview-modal");
  modal.files = files;
  modal.activePath = files[0]!.path;
  modal.contextLabel = "in morning-catchup";
  Object.assign(modal, options);
  mountSolid(() => modal, { container });
  await modal.updateComplete;
  flush();
  return modal;
}

function pressKey(target: EventTarget | null | undefined, key = "ArrowDown") {
  const init = { key, bubbles: true, cancelable: true, composed: true };
  const event = new KeyboardEvent("keydown", init);
  target?.dispatchEvent(event);
  return event;
}

function watch(target: EventTarget, name: string) {
  const listener = vi.fn();
  target.addEventListener(name, listener);
  onTestFinished(() => target.removeEventListener(name, listener));
  return listener;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await i18n.setLocale("en");
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

it("distinguishes skill and Markdown icons", async () => {
  await renderPreview({
    activePath: "SKILL.md",
    files: ["SKILL.md", "README.md"].map((path) => previewFile(path, "Instructions")),
  });
  const reference = document.createElement("div");
  mountSolid(() => createComponent(Icon, { name: "pencilSparkles" }), { container: reference });
  const paths = (element: Element | null | undefined) =>
    [...(element?.querySelectorAll("path") ?? [])].map((path) => path.getAttribute("d"));
  const expectedIcon = paths(reference.querySelector("svg"));
  expect(paths(find('[data-path="SKILL.md"] .item-icon svg'))).toEqual(expectedIcon);
  expect(paths(find('[data-path="README.md"] .item-icon svg'))).not.toEqual(expectedIcon);
});

it("emits controlled query, select, and close events", async () => {
  const modal = await renderPreview();
  const actions = find(".foot > openclaw-modal-actions");
  expect(actions?.querySelector("button")).not.toBeNull();
  expect(actions?.parentElement?.lastElementChild).toBe(actions);
  expect(actions?.querySelector(".foot-group")).toBeNull();
  expect(find(".foot > .foot-group")).not.toBeNull();
  const onQuery = watch(modal, "file-preview-query-change");
  const onSelect = watch(modal, "file-preview-select");
  const onClose = watch(modal, "file-preview-close");
  const input = find<HTMLInputElement>(".search");
  expect(input).toBeInstanceOf(HTMLInputElement);
  input!.value = "digest";
  input!.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  const secondFile = findAll<HTMLButtonElement>(".item")[1];
  expect(secondFile).toBeInstanceOf(HTMLButtonElement);
  secondFile!.click();
  pressKey(find(".modal"), "Escape");
  expect(onQuery.mock.lastCall?.[0].detail).toBe("digest");
  expect(onSelect.mock.lastCall?.[0].detail).toBe("filters/auto-senders.txt");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it.each(["files", "document"] as const)("updates %s preview/focus", async (layout) => {
  const warning = vi.spyOn(console, "warn");
  const modal = await renderPreview({ layout });
  modal.activePath = files[1]!.path;
  await modal.updateComplete;
  expect(find(".detail-body")?.textContent).toContain("noreply@example.com");
  expect(document.activeElement).toBe(find(layout === "files" ? ".search" : ".item.is-active"));
  expect(warning.mock.calls.flat().join(" ")).not.toContain("STRICT_READ_UNTRACKED");
});

it("restores modal focus when the same element reconnects", async () => {
  const modal = await renderPreview();
  const outside = document.body.appendChild(document.createElement("button"));
  onTestFinished(() => outside.remove());
  container.remove();
  await Promise.resolve();
  outside.focus();
  expect(document.activeElement).toBe(outside);
  document.body.append(container);
  await modal.updateComplete;
  const input = find<HTMLInputElement>(".search");
  expect(input).toBeInstanceOf(HTMLInputElement);
  expect(document.activeElement).toBe(input);
});

it("blocks background arrow-key scrolling even when no files match", async () => {
  await renderPreview({ query: "missing" });
  const onDocumentKeydown = watch(document, "keydown");
  const arrowDown = pressKey(find(".search"));
  expect(arrowDown.defaultPrevented).toBe(true);
  expect(onDocumentKeydown).not.toHaveBeenCalled();
});

it("preserves chunked text and resets scroll on file changes", async () => {
  const previewFiles = ["first", "second"].map((name) =>
    previewFile(`${name}.ts`, Array.from({ length: 500 }, (_, i) => `${name}-${i}`).join("\n")),
  );
  const modal = await renderPreview({ activePath: "first.ts", files: previewFiles });
  const body = find<HTMLElement>(".detail-body");
  expect(body).toBeInstanceOf(HTMLElement);
  expect(findAll(".code-chunk")).toHaveLength(8);
  const chunkText = () =>
    findAll(".code-chunk")
      .map((chunk) => chunk.textContent ?? "")
      .join("\n");
  expect(chunkText()).toBe(previewFiles[0]!.contents);
  body!.scrollTop = 2200;
  expect(body!.scrollTop).toBe(2200);
  modal.activePath = "second.ts";
  await modal.updateComplete;
  expect(find(".detail-body")?.scrollTop).toBe(0);
  expect(chunkText()).toBe(previewFiles[1]!.contents);
});

it.each(["files", "document"] as const)("preserves %s reading on sibling load", async (layout) => {
  const modal = await renderPreview({ layout });
  const body = find<HTMLElement>(".detail-body")!;
  const content = body.querySelector(".markdown, .code-content")!;
  const first = content.firstElementChild;
  Object.assign(body, { scrollTop: 240, scrollLeft: 40 });
  modal.files = files.map(({ path, size, contents }) =>
    previewFile(path, path === modal.activePath ? contents : "New sibling contents", size),
  );
  await modal.updateComplete;
  expect(find(".detail-body")).toBe(body);
  expect(content.firstElementChild).toBe(first);
  expect(body).toMatchObject({ scrollTop: 240, scrollLeft: 40 });
  expect(body.textContent).toContain("Morning digest template");
});

it("navigates expanded folders and relative Markdown links", async () => {
  const modal = await renderPreview({
    layout: "document",
    activePath: "SKILL.md",
    files: [
      previewFile("SKILL.md", "---\nname: guide\n---\n# Guide\n[Notes](notes/a.md)"),
      previewFile("hidden/a.md", "Hidden notes"),
      previewFile("notes/a.md", "Visible notes"),
    ],
  });
  const select = watch(modal, "file-preview-select");
  const hidden = findAll<HTMLDetailsElement>("details").find(
    (folder) => folder.querySelector("summary")?.textContent === "hidden",
  )!;
  hidden.open = false;
  pressKey(find(".item.is-active"));
  expect(select.mock.lastCall?.[0].detail).toBe("notes/a.md");
  expect(find(".markdown")?.textContent).not.toContain("name: guide");
  const link = find<HTMLAnchorElement>(".markdown a")!;
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(select.mock.lastCall?.[0].detail).toBe("notes/a.md");
});

it.each([true, false])("restores localized copy labels after success %s", async (copied) => {
  const write = createDeferred();
  const writeText = vi.fn(() => write.promise);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  const schedule = vi.spyOn(window, "setTimeout");
  const modal = await renderPreview();
  const button = find<HTMLButtonElement>(".chat-copy-btn")!;
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
  expect(find("openclaw-modal-dialog")).toMatchObject({ label: "Arquivos de suporte" });
  expect(modal.textContent).toContain("2 arquivos");
  expect(modal.textContent).toContain("Fechar");
  expect(button.getAttribute("aria-label")).toBe("Copiar arquivo");
  if (copied) {
    write.resolve();
  } else {
    write.reject(new DOMException("Clipboard access denied"));
  }
  const feedback = find<HTMLElement>("[role=status]")!;
  await waitForSolid(() =>
    expect(feedback.textContent).toBe(copied ? "Copiado!" : "Falha ao copiar"),
  );
  expect(feedback.hidden).toBe(false);
  expect(button.getAttribute("aria-label")).toBe(feedback.textContent);
  expect(writeText).toHaveBeenCalledWith("Morning digest template");
  const reset = schedule.mock.calls.find(([, delay]) => delay === (copied ? 1_500 : 2_000))?.[0];
  if (typeof reset !== "function") {
    throw new Error("Expected copy feedback to schedule its reset");
  }
  reset();
  flush();
  expect(button.getAttribute("aria-label")).toBe("Copiar arquivo");
  expect(feedback.hidden).toBe(true);
});

it("renders the fallback file-kind label for a prototype key", async () => {
  const path = "references/notes.constructor";
  await renderPreview({ activePath: path, files: [previewFile(path, "Example file", "12 B")] });
  expect(find(".chip.accent")?.textContent).toBe("CONSTRUCTOR");
});

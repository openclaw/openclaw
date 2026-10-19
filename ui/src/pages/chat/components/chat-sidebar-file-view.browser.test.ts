import { EditorView } from "@codemirror/view";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { canReloadControlUiDocument } from "../../../app/document-reload-guard.ts";
import { readFileDraft, setFileDraft } from "./chat-file-drafts.ts";
import type { FileSidebarContent } from "./chat-sidebar-content-types.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import "./chat-detail-panel.tsx";

// CodeMirror needs Chromium; importing vitest/browser throws in the jsdom project.
const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];

function file(content: string, overrides: Partial<FileSidebarContent> = {}): FileSidebarContent {
  return { kind: "file", path: "notes.txt", name: "notes.txt", content, ...overrides };
}

function editableFile(
  content = "before",
  edit: Partial<NonNullable<FileSidebarContent["edit"]>> = {},
  overrides: Partial<FileSidebarContent> = {},
): FileSidebarContent {
  return file(content, {
    edit: { hash: "hash-1", save: vi.fn(), fetchLatest: vi.fn(), ...edit },
    ...overrides,
  });
}

beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
});

type DetailPanel = HTMLElement & {
  content: FileSidebarContent;
  updateComplete: Promise<unknown>;
};

const mounted: HTMLElement[] = [];
const files: FileSidebarContent[] = [];

async function mountFile(content: FileSidebarContent, width?: number): Promise<DetailPanel> {
  content.draftKey ??= crypto.randomUUID();
  files.push(content);
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.content = content;
  const container = createChatSidebarContainer();
  if (width !== undefined) {
    container.className = "side-panel__panel";
    container.style.cssText = `display:flex;width:${width}px;height:320px;`;
    panel.className = "chat-sidebar";
  }
  container.append(panel);
  document.body.append(container);
  mounted.push(container);
  await panel.updateComplete;
  await expect.poll(() => panel.querySelector(".cm-editor"), { timeout: 5_000 }).not.toBeNull();
  return panel;
}

function button(panel: DetailPanel, label: string): HTMLButtonElement {
  return expectDefined(
    Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) =>
        candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
    ),
    `Missing ${label} button`,
  );
}

const editorOf = (panel: DetailPanel) =>
  expectDefined(panel.querySelector<HTMLElement>(".cm-content"), "File editor");
const click = (panel: DetailPanel, label: string) => userEvent.click(button(panel, label));
async function beginEdit(panel: DetailPanel, text?: string) {
  await click(panel, "Edit file");
  const editor = editorOf(panel);
  if (text !== undefined) {
    await userEvent.fill(editor, text);
  }
  return editor;
}
async function saveFile(panel: DetailPanel, save: { mock: { calls: unknown[][] } }, count: number) {
  await click(panel, "Save");
  await expect.poll(() => save.mock.calls.length).toBe(count);
}
async function expectAccessibleEditor(editor: HTMLElement, readonly: boolean) {
  await expect.element(editor).toHaveFocus();
  await expect.element(editor).toHaveAccessibleName("notes.txt");
  expect(editor.getAttribute("aria-readonly")).toBe(readonly ? "true" : null);
}

afterEach(() => {
  for (const panel of mounted.splice(0)) {
    panel.remove();
  }
  for (const mountedFile of files.splice(0)) {
    setFileDraft(mountedFile, null);
  }
});

describe.runIf(browserMode)("chat file editor", () => {
  it("keeps CodeMirror idle during unrelated panel property updates", async () => {
    const panel = await mountFile(editableFile("first\nsecond\nthird", {}, { line: 2 }));
    const editor = await beginEdit(panel);
    await userEvent.type(editor, "draft ");
    const draft = readFileDraft(panel.content)?.content;
    const updates = vi.spyOn(EditorView.prototype, "update");
    try {
      for (let index = 0; index < 10; index += 1) {
        Object.assign(panel, { execNode: `node-${index}` });
        await panel.updateComplete;
        await Promise.resolve();
      }
      expect(updates.mock.calls.length).toBe(0);
      expect(panel.querySelector(".cm-content")).toBe(editor);
      expect(document.activeElement).toBe(editor);
      expect(readFileDraft(panel.content)?.content).toBe(draft);
      await userEvent.type(editor, "more ");
      expect(readFileDraft(panel.content)?.content).toContain("more ");
      expect(updates.mock.calls.length).toBeGreaterThan(0);
      await click(panel, "Discard");
      panel.content.content = "Changed in-place file text\nsecond\nthird";
      Object.assign(panel, { execNode: "latest-node" });
      await panel.updateComplete;
      await expect
        .poll(() => [...editor.querySelectorAll(".cm-line")].map((line) => line.textContent))
        .toEqual(["Changed in-place file text", "second", "third"]);
      expect(editor.querySelector(".file-view__line--target")?.textContent).toBe("second");
      expect(editor.querySelector(".file-view__line--target")?.getAttribute("data-line")).toBe("2");
      expect(panel.querySelector(".cm-content")).toBe(editor);
    } finally {
      updates.mockRestore();
    }
  });

  it("wraps long lines at the panel width when word wrap is on and remembers the choice", async () => {
    localStorage.removeItem("openclaw.control.fileView.wrap.v1");
    const panel = await mountFile(
      file(`export const value = "${"long-content-".repeat(80)}";`, { path: "x.ts", name: "x.ts" }),
      320,
    );
    const fileView = panel.querySelector<HTMLElement>(".file-view")!;
    const scroller = panel.querySelector<HTMLElement>(".cm-scroller")!;
    await expect.poll(() => fileView.clientWidth).toBeGreaterThan(0);
    expect(fileView.clientWidth).toBeLessThanOrEqual(panel.parentElement!.clientWidth);
    expect(fileView.scrollWidth).toBe(fileView.clientWidth);
    await expect.poll(() => scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expect(getComputedStyle(scroller).overflowX).toBe("auto");
    const wrapButton = button(panel, "Enable word wrap");
    expect(wrapButton.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(wrapButton);
    await expect.poll(() => scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
    const line = panel.querySelector<HTMLElement>(".cm-line")!;
    expect(line.getBoundingClientRect().height).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(line).lineHeight) * 2,
    );
    expect(button(panel, "Disable word wrap").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("openclaw.control.fileView.wrap.v1")).toBe("true");
    await click(panel, "Disable word wrap");
    await expect.poll(() => scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expect(localStorage.getItem("openclaw.control.fileView.wrap.v1")).toBe("false");
    localStorage.removeItem("openclaw.control.fileView.wrap.v1");
  });

  it.each([
    { name: "mixed CRLF first", content: "first\r\nneedle\rlast\r\nneedle", matchLines: [1, 3] },
    {
      name: "editable mixed LF first",
      content: "first\nneedle\rlast\r\nneedle",
      matchLines: [1, 3],
      editable: true,
    },
  ])("searches the displayed lines in $name files", async ({ content, matchLines, editable }) => {
    const panel = await mountFile(editable ? editableFile(content) : file(content));
    await click(panel, "Search in file");
    await userEvent.fill(panel.querySelector<HTMLInputElement>('input[type="search"]')!, "needle");
    const lineIndexes = (selector: string) => {
      const lines = Array.from(panel.querySelectorAll(".cm-line"));
      return Array.from(panel.querySelectorAll(selector), (line) => lines.indexOf(line));
    };
    await expect.poll(() => lineIndexes(".file-view__line--match")).toEqual(matchLines);
    expect(panel.querySelector(".file-view__search-counter")?.textContent?.trim()).toBe("1/2");
    expect(lineIndexes(".file-view__line--current")).toEqual([matchLines[0]]);
    await click(panel, "Next match");
    await expect.poll(() => lineIndexes(".file-view__line--current")).toEqual([matchLines[1]]);
    await click(panel, "Previous match");
    await expect.poll(() => lineIndexes(".file-view__line--current")).toEqual([matchLines[0]]);
    expect(readFileDraft(panel.content)).toBeUndefined();
    expect(canReloadControlUiDocument()).toBe(true);
    panel.remove();
    expect(canReloadControlUiDocument()).toBe(true);
  });

  it("clears a mixed-line-ending draft when an edit is undone", async () => {
    const panel = await mountFile(editableFile("first\nsecond\rthird\r\nlast"));
    const editor = await beginEdit(panel);
    await userEvent.type(editor, "x");
    expect(readFileDraft(panel.content)?.content).toBe("xfirst\nsecond\nthird\nlast");
    expect(canReloadControlUiDocument()).toBe(false);
    await userEvent.keyboard(
      navigator.platform === "MacIntel" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
    );
    await expect.poll(() => button(panel, "Save").disabled).toBe(true);
    expect(readFileDraft(panel.content)).toBeUndefined();
    panel.remove();
    expect(canReloadControlUiDocument()).toBe(true);
  });

  it("closes file search from every search control and preserves keyboard navigation", async () => {
    const panel = await mountFile(
      file('["雪",\n"雪",\n"雪"]', { path: "search.json", name: "search.json" }),
    );
    const searchToggle = button(panel, "Search in file");
    const counter = () => panel.querySelector(".file-view__search-counter")?.textContent?.trim();
    for (const control of ["input", "Previous match", "Next match"]) {
      await userEvent.click(searchToggle);
      const input = panel.querySelector<HTMLInputElement>('input[type="search"]')!;
      await expect.poll(() => document.activeElement).toBe(input);
      expect(input.value).toBe("");
      await userEvent.fill(input, "雪");
      expect(counter()).toBe("1/3");
      if (control === "input") {
        await userEvent.keyboard("{Enter}");
        expect(counter()).toBe("2/3");
        await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
        expect(counter()).toBe("1/3");
      } else {
        const navigation = button(panel, control);
        await userEvent.click(navigation);
        expect(document.activeElement).toBe(navigation);
        expect(counter()).toBe(control === "Previous match" ? "3/3" : "2/3");
        await userEvent.keyboard("{Enter}");
        expect(counter()).toBe(control === "Previous match" ? "2/3" : "3/3");
        await userEvent.keyboard(" ");
        expect(counter()).toBe("1/3");
      }
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => panel.querySelector('input[type="search"]')).toBeNull();
      expect(document.activeElement).toBe(searchToggle);
      expect(searchToggle.getAttribute("aria-pressed")).toBe("false");
    }
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => document.activeElement === panel.querySelector('input[type="search"]'))
      .toBe(true);
    expect(panel.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
    await userEvent.click(searchToggle);
    await expect.poll(() => panel.querySelector('input[type="search"]')).toBeNull();
    expect(document.activeElement).toBe(searchToggle);
  });

  it("keeps the named file view keyboard accessible through editing and saving", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-2" });
    const panel = await mountFile(editableFile("before", { save }));
    const editor = editorOf(panel);
    button(panel, "Copy file contents").focus();
    await userEvent.tab();
    await expectAccessibleEditor(editor, true);
    button(panel, "Edit file").focus();
    await userEvent.keyboard("{Enter}");
    await expectAccessibleEditor(editor, false);
    await userEvent.fill(editor, "after");
    const saveButton = button(panel, "Save");
    expect(saveButton.disabled).toBe(false);
    await userEvent.click(saveButton);
    await expect.poll(() => save.mock.calls.length).toBe(1);
    expect(save).toHaveBeenCalledWith({ content: "after", expectedHash: "hash-1" });
    await expect.poll(() => button(panel, "Save").disabled).toBe(true);
    expect(editorOf(panel).textContent).toContain("after");
    await click(panel, "Discard");
    button(panel, "Copy file contents").focus();
    await userEvent.tab();
    await expectAccessibleEditor(editor, true);
  });

  it.each(["\n", "\r\n", "\r"])(
    "round-trips %j line endings through typing, paste, and replacement",
    async (separator) => {
      const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-2" });
      const panel = await mountFile(editableFile(`alpha${separator}beta`, { save }));
      const editor = await beginEdit(panel);
      await userEvent.type(editor, "x");
      await saveFile(panel, save, 1);
      expect(save.mock.calls[0]?.[0]).toMatchObject({ content: `xalpha${separator}beta` });
      await userEvent.click(editor);
      await userEvent.keyboard(
        navigator.platform === "MacIntel" ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
      );
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "first\r\nsecond\nthird\rfourth 🦞\n");
      editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      await saveFile(panel, save, 2);
      expect(save.mock.calls[1]?.[0]).toEqual({
        content: ["first", "second", "third", "fourth 🦞", ""].join(separator),
        expectedHash: "hash-2",
      });
      expect(panel.querySelectorAll(".cm-line")).toHaveLength(5);
      await userEvent.fill(editor, "replacement\nlast 🦞\n");
      await saveFile(panel, save, 3);
      expect(save.mock.calls[2]?.[0]).toEqual({
        content: ["replacement", "last 🦞", ""].join(separator),
        expectedHash: "hash-2",
      });
      expect(panel.querySelectorAll(".cm-line")).toHaveLength(3);
    },
  );

  it("keeps edits made while a save is in flight dirty", async () => {
    const saving = createDeferred<{ ok: true; hash: string }>();
    const save = vi.fn(() => saving.promise);
    const panel = await mountFile(editableFile("before", { save }));
    const editor = await beginEdit(panel);
    await userEvent.fill(editor, "submitted");
    await click(panel, "Save");
    await userEvent.fill(editor, "newer");
    saving.resolve({ ok: true, hash: "hash-2" });
    await expect.poll(() => button(panel, "Save").textContent?.trim()).toBe("Save");
    expect(button(panel, "Save").disabled).toBe(false);
    expect(editor.textContent).toContain("newer");
    await click(panel, "Discard");
  });

  it("restores an unsaved draft after the detail panel is closed", async () => {
    const draftKey = "session-a\u0000notes.txt";
    const first = await mountFile(editableFile("before", {}, { draftKey }));
    await beginEdit(first, "unsaved draft");
    first.remove();
    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-3" });
    const reopened = await mountFile(
      editableFile("latest", { hash: "hash-2", save }, { draftKey }),
    );
    await expect.poll(() => editorOf(reopened).textContent).toContain("unsaved");
    expect(editorOf(reopened).getAttribute("contenteditable")).toBe("true");
    expect(button(reopened, "Save").disabled).toBe(false);
    await click(reopened, "Discard");
    await beginEdit(reopened, "new edit");
    await click(reopened, "Save");
    await expect.poll(() => save.mock.calls.length).toBe(1);
    expect(save).toHaveBeenCalledWith({ content: "new edit", expectedHash: "hash-2" });
  });

  it("scopes retained drafts to the session file identity", async () => {
    const sharedEdit = { hash: "hash-1", save: vi.fn(), fetchLatest: vi.fn() };
    const ownerFile = (pane: string, content: string) =>
      file(content, {
        edit: sharedEdit,
        path: "shared.txt",
        name: "shared.txt",
        draftKey: `gateway-a\u0000pane-${pane}\u0000session-a\u0000shared.txt`,
      });
    const first = await mountFile(ownerFile("left", "session a"));
    await beginEdit(first, "session a draft");
    first.remove();
    const otherSession = await mountFile(ownerFile("right", "session b"));
    expect(editorOf(otherSession).textContent).toContain("session b");
    expect(editorOf(otherSession).getAttribute("contenteditable")).toBe("false");
    const restored = await mountFile(ownerFile("left", "session a"));
    await expect.poll(() => editorOf(restored).textContent).toContain("draft");
    await click(restored, "Discard");
  });

  it.each(["mixed\r\nendings\nnow", "mixed\nendings\r\nnow"])(
    "drops edit mode and its draft when a conflict reload returns %j",
    async (content) => {
      const save = vi.fn().mockResolvedValue({ ok: false, code: "conflict" });
      const fetchLatest = vi.fn().mockResolvedValue({
        content,
        hash: "hash-2",
        editable: false,
      });
      const panel = await mountFile(editableFile("before", { save, fetchLatest }));
      await beginEdit(panel, "local");
      await click(panel, "Save");
      await expect.poll(() => panel.querySelector('[role="alert"]')).not.toBeNull();
      await click(panel, "Reload");
      await expect.poll(() => editorOf(panel).textContent).toContain("mixed");
      expect(editorOf(panel).getAttribute("contenteditable")).toBe("false");
      expect(panel.querySelector('button[aria-label="Edit file"]')).toBeNull();
      expect(readFileDraft(panel.content)).toBeUndefined();
      expect(canReloadControlUiDocument()).toBe(true);
      panel.remove();
      expect(canReloadControlUiDocument()).toBe(true);
    },
  );

  it("makes the editor read-only while reloading a conflict", async () => {
    const reloading = createDeferred<{ content: string; hash: string; editable: boolean }>();
    const save = vi.fn().mockResolvedValue({ ok: false, code: "conflict" });
    const fetchLatest = vi.fn(() => reloading.promise);
    const panel = await mountFile(editableFile("before", { save, fetchLatest }));
    await beginEdit(panel, "local");
    await click(panel, "Save");
    await expect
      .poll(() => panel.querySelector('[role="alert"]')?.textContent)
      .toContain("File changed on disk since it was loaded.");
    await click(panel, "Reload");
    await expect.poll(() => editorOf(panel).getAttribute("contenteditable")).toBe("false");
    reloading.resolve({ content: "latest", hash: "hash-2", editable: true });
    await expect.poll(() => editorOf(panel).textContent).toContain("latest");
    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(button(panel, "Save").disabled).toBe(true);
    expect(editorOf(panel).getAttribute("contenteditable")).toBe("true");
  });
});

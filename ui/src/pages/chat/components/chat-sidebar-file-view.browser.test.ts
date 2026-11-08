import { EditorView } from "@codemirror/view";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { canReloadControlUiDocument } from "../../../app/document-reload-guard.ts";
import { readFileDraft, setFileDraft } from "./chat-file-drafts.ts";
import type { FileReaderDraftState, FileSidebarContent } from "./chat-sidebar-content-types.ts";
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

async function mountFile(
  content: FileSidebarContent,
  width?: number,
  presentation: "desktop" | "mobile" = "mobile",
): Promise<DetailPanel> {
  content.draftKey ??= crypto.randomUUID();
  files.push(content);
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  Object.assign(panel, { filePresentation: presentation });
  panel.content = content;
  const container = createChatSidebarContainer();
  container.className = "side-panel__panel";
  container.style.cssText =
    "display:flex;height:320px;width:" + (width === undefined ? "100%" : width + "px");
  panel.className = "chat-sidebar";
  container.append(panel);
  document.body.append(container);
  mounted.push(container);
  await panel.updateComplete;
  await expect
    .poll(
      () =>
        panel.querySelector(
          ".cm-editor, .sidebar-markdown, .sidebar-svg-file__view:not([hidden]) img",
        ),
      { timeout: 5_000 },
    )
    .not.toBeNull();
  return panel;
}

function button(panel: DetailPanel, label: string): HTMLButtonElement {
  return expectDefined(
    Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) =>
        candidate.checkVisibility({ checkVisibilityCSS: true }) &&
        (candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label),
    ),
    `Missing ${label} button`,
  );
}

async function openMobileFileActions(panel: DetailPanel) {
  const trigger = button(panel, "Workspace file actions");
  if (trigger.getAttribute("aria-expanded") !== "true") {
    await userEvent.click(trigger);
  }
  await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
}

const unmountFile = (panel: DetailPanel) =>
  expectDefined(panel.parentElement, "Reader host").remove();

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

async function desktopViewport() {
  const { page } = await import("vitest/browser");
  const { innerWidth, innerHeight } = window;
  onTestFinished(() => page.viewport(innerWidth, innerHeight));
  await page.viewport(1200, 800);
}

const shortcut = (key: string) =>
  userEvent.keyboard(
    navigator.platform === "MacIntel" ? `{Meta>}${key}{/Meta}` : `{Control>}${key}{/Control}`,
  );

afterEach(() => {
  for (const panel of mounted.splice(0)) {
    panel.remove();
  }
  for (const mountedFile of files.splice(0)) {
    setFileDraft(mountedFile, null);
  }
});

describe.runIf(browserMode)("chat file editor", () => {
  it.each(["desktop", "mobile"] as const)(
    "preserves generic-text SVG reading and editing in %s",
    async (presentation) => {
      await desktopViewport();
      const source =
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>';
      const saved = source.replace('fill="red"', 'fill="blue"');
      const save = vi.fn(async () => ({ ok: true as const, hash: "saved-svg" }));
      const content = editableFile(
        source,
        { save },
        {
          name: "diagram.svg",
          path: "diagram.svg",
          mimeType: "text/plain",
          download: async () => ({ blob: new Blob([source]), filename: "diagram.svg" }),
        },
      );
      const panel = await mountFile(content, presentation === "desktop" ? 720 : 360, presentation);
      if (presentation === "mobile") {
        expect(panel.querySelector(".sidebar-svg-file")).toBeNull();
        expect(EditorView.findFromDOM(editorOf(panel))!.state.doc.toString()).toBe(source);
        await beginEdit(panel, saved);
        expect(readFileDraft(content)?.content).toBe(saved);
        return;
      }
      const image = () =>
        expectDefined(
          panel.querySelector<HTMLImageElement>(".sidebar-svg-file img"),
          "SVG preview",
        );
      await expect.poll(() => image().naturalWidth).toBe(32);
      await expect.element(image()).toBeVisible();
      Object.assign(panel, { fileNavigation: { line: 1 } });
      await expect.poll(() => panel.querySelector(".cm-content")).not.toBeNull();
      expect(EditorView.findFromDOM(editorOf(panel))!.state.doc.toString()).toBe(source);
      expect(button(panel, "Enable word wrap").getAttribute("aria-pressed")).toBe("false");
      await click(panel, "File actions");
      await click(panel, "Search in file");
      await userEvent.fill(panel.querySelector<HTMLInputElement>('input[type="search"]')!, "rect");
      await expect.poll(() => panel.querySelector('[role="status"]')?.textContent).toBe("1/1");
      await click(panel, "Reading mode: Highlighted source");
      await click(panel, "Preview");
      expect(panel.querySelector('input[type="search"]')).toBeNull();
      await expect.element(image()).toBeVisible();
      await beginEdit(panel, saved);
      expect(readFileDraft(content)?.content).toBe(saved);
      unmountFile(panel);
      const reopened = await mountFile(content, 720, "desktop");
      expect(EditorView.findFromDOM(editorOf(reopened))!.state.doc.toString()).toBe(saved);
      await saveFile(reopened, save, 1);
      await expect.poll(() => readFileDraft(content)).toBeUndefined();
      await click(reopened, "Discard");
      const updated = expectDefined(
        reopened.querySelector<HTMLImageElement>(".sidebar-svg-file img"),
        "Saved SVG",
      );
      await expect.element(updated).toBeVisible();
      expect(decodeURIComponent(updated.src.split(",", 2)[1]!)).toBe(saved);
      expect(content.content).toBe(saved);
    },
  );

  it.each(["desktop", "mobile"] as const)(
    "renders a complete large Markdown file in %s preview without changing its source or safety",
    async (presentation) => {
      if (presentation === "desktop") {
        await desktopViewport();
      }
      const source = [
        "# Large document",
        "| Item | Status |\n| --- | --- |\n| Preview | Complete |",
        "- Read the whole file",
        "```js\n" + 'console.log("document preview");\n'.repeat(12) + "```",
        "[Related file](docs/guide.md)",
        "Related session: `agent:main:main`",
        "![Remote image](https://example.com/preview.png)",
        '<script>alert(1)</script><img src="x" onerror="alert(1)">',
        "[Unsafe link](javascript:alert(1))",
        "Document body. ".repeat(4_500),
        "## Final heading",
      ].join("\n\n");
      const panel = await mountFile(
        file(source, { path: "large.md", name: "large.md", mimeType: "text/markdown" }),
        presentation === "desktop" ? 720 : 360,
        presentation,
      );
      const openFile = vi.fn();
      const openSession = vi.fn();
      Object.assign(panel, { onOpenWorkspaceFile: openFile, onOpenSessionLink: openSession });
      await panel.updateComplete;
      const preview = () =>
        expectDefined(panel.querySelector<HTMLElement>(".sidebar-markdown"), "Markdown preview");
      await expect.poll(() => preview().querySelector("h1")?.textContent).toBe("Large document");
      expect(preview().querySelector("table td")?.textContent).toBe("Preview");
      expect(preview().querySelector("ul li")?.textContent).toBe("Read the whole file");
      expect(preview().querySelector("pre code")?.textContent).toContain("document preview");
      expect(preview().querySelector("h2")?.textContent).toBe("Final heading");
      expect(preview().querySelector(".markdown-plain-text-fallback")).toBeNull();
      expect(preview().querySelector('img[src="https://example.com/preview.png"]')).toBeNull();
      expect(preview().querySelector('a[href="https://example.com/preview.png"]')).not.toBeNull();
      expect(preview().querySelector('script, [onerror], [href^="javascript:"]')).toBeNull();
      await userEvent.click(preview().querySelector<HTMLElement>("[data-file-path]")!);
      expect(openFile).toHaveBeenCalled();
      await userEvent.click(preview().querySelector<HTMLElement>("[data-session-key]")!);
      expect(openSession).toHaveBeenCalled();
      await userEvent.click(preview().querySelector<HTMLButtonElement>(".code-block-expand")!);
      expect(preview().querySelector(".code-block-wrapper")?.classList).toContain("is-expanded");

      if (presentation === "desktop") {
        await click(panel, "Reading mode: Preview");
        await click(panel, "Plain source");
      } else {
        await click(panel, "Source");
      }
      await expect.poll(() => panel.querySelector(".cm-editor")).not.toBeNull();
      await expect.element(editorOf(panel)).toBeVisible();
      const view = expectDefined(EditorView.findFromDOM(editorOf(panel)), "Source editor");
      expect(view.state.doc.toString()).toBe(source);
      if (presentation === "desktop") {
        await click(panel, "Reading mode: Plain source");
      }
      await click(panel, "Preview");
      await expect.poll(() => preview().querySelector("h2")?.textContent).toBe("Final heading");
      expect(panel.content.content).toBe(source);
    },
  );

  it("toggles desktop highlighting without replacing the document, selection or undo history", async () => {
    await desktopViewport();
    const panel = await mountFile(
      editableFile("const answer = 42;", {}, { name: "answer.ts", path: "answer.ts" }),
      720,
      "desktop",
    );
    const editor = editorOf(panel);
    await expect.poll(() => editor.querySelector(".tok-keyword")).not.toBeNull();
    await userEvent.click(editor);
    await shortcut("a");
    const view = EditorView.findFromDOM(editor)!;
    const selection = view.state.selection;
    await click(panel, "Syntax highlighting");
    await expect.poll(() => editor.querySelector(".tok-keyword")).toBeNull();
    expect(view.state.selection.eq(selection)).toBe(true);
    await expect.element(button(panel, "Syntax highlighting")).toHaveFocus();
    expect(EditorView.findFromDOM(editorOf(panel))).toBe(view);
    expect(view.state.doc.toString()).toBe("const answer = 42;");
    await click(panel, "Syntax highlighting");
    await expect.poll(() => editor.querySelector(".tok-keyword")).not.toBeNull();
    expect(editorOf(panel)).toBe(editor);
    await beginEdit(panel, "changed");
    await shortcut("z");
    await expect.poll(() => editor.textContent).toBe("const answer = 42;");
    expect(readFileDraft(panel.content)).toBeUndefined();
  });

  it("keeps desktop wrap local to each document", async () => {
    await desktopViewport();
    localStorage.setItem("openclaw.control.fileView.wrap.v1", "true");
    onTestFinished(() => localStorage.removeItem("openclaw.control.fileView.wrap.v1"));
    const panel = await mountFile(file("first"), 720, "desktop");
    expect(button(panel, "Disable word wrap").getAttribute("aria-pressed")).toBe("true");
    await click(panel, "Disable word wrap");
    const second = await mountFile(file("second"), 720, "desktop");
    expect(button(second, "Disable word wrap").getAttribute("aria-pressed")).toBe("true");
    expect(button(panel, "Enable word wrap").getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps CodeMirror idle during unrelated panel property updates", async () => {
    const panel = await mountFile(editableFile("first\nsecond\nthird", {}, { line: 2 }));
    const editor = await beginEdit(panel);
    await userEvent.type(editor, "draft ");
    const draft = readFileDraft(panel.content)?.content;
    const view = expectDefined(EditorView.findFromDOM(editor), "File editor view");
    const updates = vi.spyOn(view, "update");
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
    await openMobileFileActions(panel);
    const wrapButton = button(panel, "Enable word wrap");
    expect(wrapButton.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(wrapButton);
    await expect.poll(() => scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
    const line = panel.querySelector<HTMLElement>(".cm-line")!;
    expect(line.getBoundingClientRect().height).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(line).lineHeight) * 2,
    );
    await openMobileFileActions(panel);
    expect(button(panel, "Disable word wrap").getAttribute("aria-checked")).toBe("true");
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
    expect(panel.querySelector('[role="search"] [role="status"]')?.textContent?.trim()).toBe("1/2");
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
    await shortcut("z");
    await expect.poll(() => button(panel, "Save").disabled).toBe(true);
    expect(readFileDraft(panel.content)).toBeUndefined();
    panel.remove();
    expect(canReloadControlUiDocument()).toBe(true);
  });

  it("closes file search from every search control and preserves keyboard navigation", async () => {
    const panel = await mountFile(
      file('["雪",\n"雪",\n"雪"]', { path: "search.json", name: "search.json" }),
    );
    const searchToggle = () => button(panel, "Search in file");
    const counter = () =>
      panel.querySelector('[role="search"] [role="status"]')?.textContent?.trim();
    for (const control of ["input", "Previous match", "Next match"]) {
      await userEvent.click(searchToggle());
      const input = panel.querySelector<HTMLInputElement>('input[type="search"]')!;
      await expect.poll(() => document.activeElement).toBe(input);
      expect(input.value).toBe("");
      await userEvent.fill(input, "雪");
      expect(counter()).toBe("1/3");
      const focusTarget = control === "input" ? input : button(panel, control);
      if (control === "input") {
        await userEvent.keyboard("{Enter}");
        expect(counter()).toBe("2/3");
        await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
        expect(counter()).toBe("1/3");
      } else {
        await userEvent.click(focusTarget);
        expect(document.activeElement).toBe(focusTarget);
        expect(counter()).toBe(control === "Previous match" ? "3/3" : "2/3");
        await userEvent.keyboard("{Enter}");
        expect(counter()).toBe(control === "Previous match" ? "2/3" : "3/3");
        await userEvent.keyboard(" ");
        expect(counter()).toBe("1/3");
      }
      // Close replaces Search under the pointer while the new input receives focus.
      const tooltipTrigger = control === "input" ? button(panel, "Close") : focusTarget;
      await userEvent.hover(editorOf(panel));
      await userEvent.hover(tooltipTrigger);
      const tooltip = tooltipTrigger.closest("openclaw-tooltip")!;
      await expect.poll(() => tooltip.hasAttribute("open")).toBe(true);
      // Escape dismisses the active tooltip before the surrounding find controls.
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => tooltip.hasAttribute("open")).toBe(false);
      await expect.element(input).toBeVisible();
      expect(document.activeElement).toBe(focusTarget);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => panel.querySelector('input[type="search"]')).toBeNull();
      expect(document.activeElement).toBe(searchToggle());
    }
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => document.activeElement === panel.querySelector('input[type="search"]'))
      .toBe(true);
    expect(panel.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
    await click(panel, "Close");
    await expect.poll(() => panel.querySelector('input[type="search"]')).toBeNull();
    expect(document.activeElement).toBe(searchToggle());
  });

  it("keeps the named file view keyboard accessible through editing and saving", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-2" });
    const panel = await mountFile(editableFile("before", { save }));
    const editor = editorOf(panel);
    button(panel, "Workspace file actions").focus();
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
    button(panel, "Workspace file actions").focus();
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
      await shortcut("a");
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
    let state: FileReaderDraftState | null = null;
    const latest = () => expectDefined(state, "Published reader draft");
    Object.assign(panel, {
      onFileDraftChange: (next: FileReaderDraftState | null) => {
        state = next;
      },
    });
    const editor = await beginEdit(panel);
    await userEvent.fill(editor, "submitted");
    await expect.poll(() => latest().dirty).toBe(true);
    const completion = latest().save();
    await expect.poll(() => latest().saving).toBe(true);
    expect(latest().discard()).toBe(false);
    await userEvent.fill(editor, "newer");
    saving.resolve({ ok: true, hash: "hash-2" });
    expect(await completion).toBe(false);
    await expect.poll(() => button(panel, "Save").textContent?.trim()).toBe("Save");
    expect(button(panel, "Save").disabled).toBe(false);
    expect(editor.textContent).toContain("newer");
    expect(latest().discard()).toBe(true);
    const retired = latest();
    panel.remove();
    expect(retired.discard()).toBe(false);
    expect(await retired.save()).toBe(false);
  });

  it("releases save progress when content changes before an admitted save settles", async () => {
    const saving = createDeferred<{ ok: true; hash: string }>();
    const save = vi.fn(() => saving.promise);
    const panel = await mountFile(editableFile("before", { save }));
    await beginEdit(panel, "submitted");
    await saveFile(panel, save, 1);
    await expect.poll(() => button(panel, "Saving…").disabled).toBe(true);

    const replacement = editableFile("replacement");
    files.push(replacement);
    panel.content = replacement;
    await panel.updateComplete;
    await expect.poll(() => editorOf(panel).textContent).toContain("replacement");
    await beginEdit(panel, "replacement draft");
    expect(button(panel, "Save").disabled).toBe(false);

    saving.resolve({ ok: true, hash: "hash-2" });
    await expect.poll(() => editorOf(panel).textContent).toContain("replacement draft");
    expect(save).toHaveBeenCalledOnce();
    expect(button(panel, "Save").disabled).toBe(false);
  });

  it("restores an unsaved draft after the detail panel is closed", async () => {
    const draftKey = "session-a\u0000notes.txt";
    const first = await mountFile(editableFile("before", {}, { draftKey }));
    await beginEdit(first, "unsaved draft");
    unmountFile(first);
    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-3" });
    const reopened = await mountFile(
      editableFile("latest", { hash: "hash-2", save }, { draftKey }),
    );
    await expect.poll(() => editorOf(reopened).textContent).toContain("unsaved");
    expect(editorOf(reopened).getAttribute("contenteditable")).toBe("true");
    expect(button(reopened, "Save").disabled).toBe(false);
    await click(reopened, "Discard");
    await beginEdit(reopened, "new edit");
    await saveFile(reopened, save, 1);
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
    unmountFile(first);
    const otherSession = await mountFile(ownerFile("right", "session b"));
    expect(editorOf(otherSession).textContent).toContain("session b");
    expect(editorOf(otherSession).getAttribute("contenteditable")).toBe("false");
    unmountFile(otherSession);
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

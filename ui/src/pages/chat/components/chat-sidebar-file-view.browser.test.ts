import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canReloadControlUiDocument } from "../../../app/document-reload-guard.ts";
import { readFileDraft } from "./chat-file-drafts.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import "./chat-sidebar.ts";

// The root jsdom ui shard also collects *.browser.test.ts files; CodeMirror
// needs a real DOM, so this suite only runs in the checks-ui Chromium project.
// Importing vitest/browser statically would throw during jsdom collection.
const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];

type FileSidebarContent = {
  kind: "file";
  path: string;
  name: string;
  content: string;
  draftKey?: string;
  language?: string;
  line?: number | null;
  edit?: {
    hash: string;
    save: (params: {
      content: string;
      expectedHash: string;
    }) => Promise<
      | { ok: true; hash: string }
      | { ok: false; code: "conflict"; latest: { content: string; hash: string } }
      | { ok: false; code: "error"; message: string }
    >;
    fetchLatest: () => Promise<{ content: string; hash: string; editable: boolean } | null>;
  };
};

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

async function mountFile(content: FileSidebarContent, width?: number): Promise<DetailPanel> {
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.content = content;
  if (width === undefined) {
    document.body.append(panel);
    mounted.push(panel);
  } else {
    const container = document.createElement("div");
    container.className = "side-panel__panel";
    container.style.cssText = `display:flex;width:${width}px;height:320px;`;
    panel.className = "chat-sidebar";
    container.append(panel);
    document.body.append(container);
    mounted.push(container);
  }
  await panel.updateComplete;
  await expect.poll(() => panel.querySelector(".cm-editor"), { timeout: 5_000 }).not.toBeNull();
  return panel;
}

function button(panel: DetailPanel, label: string): HTMLButtonElement {
  const match = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  if (!match) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

afterEach(() => {
  for (const panel of mounted.splice(0)) {
    panel.remove();
  }
});

describe.runIf(browserMode)("chat file editor", () => {
  it("keeps long lines inside Review and gives horizontal scroll to the editor", async () => {
    const panel = await mountFile(
      {
        kind: "file",
        path: "src/long-line.ts",
        name: "long-line.ts",
        content: `export const value = "${"long-content-".repeat(80)}";`,
      },
      320,
    );

    const fileView = panel.querySelector<HTMLElement>(".file-view")!;
    const scroller = panel.querySelector<HTMLElement>(".cm-scroller")!;
    await expect.poll(() => fileView.clientWidth).toBeGreaterThan(0);
    expect(fileView.clientWidth).toBeLessThanOrEqual(panel.parentElement!.clientWidth);
    expect(fileView.scrollWidth).toBe(fileView.clientWidth);
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expect(getComputedStyle(scroller).overflowX).toBe("auto");
  });

  it("wraps long lines at the panel width when word wrap is on and remembers the choice", async () => {
    localStorage.removeItem("openclaw.control.fileView.wrap.v1");
    const panel = await mountFile(
      {
        kind: "file",
        path: "src/long-line.ts",
        name: "long-line.ts",
        content: `export const value = "${"long-content-".repeat(80)}";`,
      },
      320,
    );
    const scroller = panel.querySelector<HTMLElement>(".cm-scroller")!;
    await expect.poll(() => scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);

    const wrapButton = button(panel, "Enable word wrap");
    expect(wrapButton.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(wrapButton);

    await expect.poll(() => scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
    // One logical line now occupies several visual rows.
    const line = panel.querySelector<HTMLElement>(".cm-line")!;
    expect(line.getBoundingClientRect().height).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(line).lineHeight) * 2,
    );
    expect(button(panel, "Disable word wrap").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("openclaw.control.fileView.wrap.v1")).toBe("true");

    await userEvent.click(button(panel, "Disable word wrap"));
    await expect.poll(() => scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expect(localStorage.getItem("openclaw.control.fileView.wrap.v1")).toBe("false");
    localStorage.removeItem("openclaw.control.fileView.wrap.v1");
  });

  it("renders content and decorates the requested line", async () => {
    const panel = await mountFile({
      kind: "file",
      path: "src/example.ts",
      name: "example.ts",
      content: "const first = 1;\nconst second = 2;",
      line: 2,
    });

    expect(panel.querySelector(".cm-content")?.textContent).toContain("const second = 2;");
    const target = panel.querySelector(".file-view__line--target");
    expect(target?.getAttribute("data-line")).toBe("2");
  });

  it.each([
    { name: "LF", content: "first\nneedle\nlast\nneedle\n", matchLines: [1, 3] },
    { name: "CRLF", content: "first\r\nneedle\r\nlast\r\nneedle\r\n", matchLines: [1, 3] },
    { name: "CR", content: "first\rneedle\rlast\rneedle\r", matchLines: [1, 3] },
    { name: "mixed CRLF first", content: "first\r\nneedle\rlast\r\nneedle", matchLines: [1, 2] },
    { name: "mixed LF first", content: "first\nneedle\rlast\r\nneedle", matchLines: [1, 3] },
    {
      name: "editable mixed LF first",
      content: "first\nneedle\rlast\r\nneedle",
      matchLines: [1, 3],
      editable: true,
    },
  ])("searches the displayed lines in $name files", async ({ content, matchLines, editable }) => {
    const panel = await mountFile({
      kind: "file",
      path: "search.txt",
      name: "search.txt",
      draftKey: crypto.randomUUID(),
      content,
      ...(editable ? { edit: { hash: "hash-1", save: vi.fn(), fetchLatest: vi.fn() } } : {}),
    });
    await userEvent.click(button(panel, "Search in file"));
    await userEvent.fill(panel.querySelector<HTMLInputElement>('input[type="search"]')!, "needle");
    const lineIndexes = (selector: string) => {
      const lines = Array.from(panel.querySelectorAll(".cm-line"));
      return Array.from(panel.querySelectorAll(selector), (line) => lines.indexOf(line));
    };
    await expect.poll(() => lineIndexes(".file-view__line--match")).toEqual(matchLines);
    expect(panel.querySelector(".file-view__search-counter")?.textContent?.trim()).toBe("1/2");
    expect(lineIndexes(".file-view__line--current")).toEqual([matchLines[0]]);
    await userEvent.click(button(panel, "Next match"));
    await expect.poll(() => lineIndexes(".file-view__line--current")).toEqual([matchLines[1]]);
    await userEvent.click(button(panel, "Previous match"));
    await expect.poll(() => lineIndexes(".file-view__line--current")).toEqual([matchLines[0]]);
    expect(readFileDraft(panel.content)).toBeUndefined();
    panel.remove();
    expect(canReloadControlUiDocument()).toBe(true);
  });

  it("clears a mixed-line-ending draft when an edit is undone", async () => {
    const panel = await mountFile({
      kind: "file",
      path: "mixed.txt",
      name: "mixed.txt",
      draftKey: crypto.randomUUID(),
      content: "first\nsecond\rthird\r\nlast",
      edit: { hash: "hash-1", save: vi.fn(), fetchLatest: vi.fn() },
    });
    await userEvent.click(button(panel, "Edit file"));
    const editor = panel.querySelector<HTMLElement>(".cm-content")!;
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
    const panel = await mountFile({
      kind: "file",
      path: "search.json",
      name: "search.json",
      content: '{\n"first":"雪",\n"second":"雪",\n"third":"雪"\n}\n',
    });
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
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest: vi.fn() },
    });

    const editor = panel.querySelector<HTMLElement>(".cm-content");
    expect(editor).not.toBeNull();
    button(panel, "Copy file contents").focus();
    await userEvent.tab();
    await expect.element(editor!).toHaveFocus();
    await expect.element(editor!).toHaveAccessibleName("notes.txt");
    expect(editor!.getAttribute("aria-readonly")).toBe("true");

    button(panel, "Edit file").focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(editor!).toHaveFocus();
    await expect.element(editor!).toHaveAccessibleName("notes.txt");
    expect(editor!.hasAttribute("aria-readonly")).toBe(false);
    await userEvent.fill(editor!, "after");
    const saveButton = button(panel, "Save");
    expect(saveButton.disabled).toBe(false);
    await userEvent.click(saveButton);

    await expect.poll(() => save.mock.calls.length).toBe(1);
    expect(save).toHaveBeenCalledWith({ content: "after", expectedHash: "hash-1" });
    await expect.poll(() => button(panel, "Save").disabled).toBe(true);
    expect(panel.querySelector(".cm-content")?.textContent).toContain("after");

    await userEvent.click(button(panel, "Discard"));
    button(panel, "Copy file contents").focus();
    await userEvent.tab();
    await expect.element(editor!).toHaveFocus();
    await expect.element(editor!).toHaveAccessibleName("notes.txt");
    expect(editor!.getAttribute("aria-readonly")).toBe("true");
  });

  it.each(["\n", "\r\n", "\r"])(
    "round-trips %j line endings through an edit and save",
    async (separator) => {
      const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-2" });
      const panel = await mountFile({
        kind: "file",
        path: "notes.txt",
        name: "notes.txt",
        content: `alpha${separator}beta`,
        edit: { hash: "hash-1", save, fetchLatest: vi.fn() },
      });

      await userEvent.click(button(panel, "Edit file"));
      const editor = panel.querySelector<HTMLElement>(".cm-content");
      expect(editor).not.toBeNull();
      await userEvent.type(editor!, "x");
      await userEvent.click(button(panel, "Save"));

      await expect.poll(() => save.mock.calls.length).toBe(1);
      const saved = expectDefined(save.mock.calls[0], "save callback call")[0] as {
        content: string;
      };
      expect(saved.content).toBe(`xalpha${separator}beta`);
    },
  );

  it("keeps edits made while a save is in flight dirty", async () => {
    let finishSave: ((outcome: { ok: true; hash: string }) => void) | undefined;
    const save = vi.fn().mockImplementation(
      () =>
        new Promise<{ ok: true; hash: string }>((resolve) => {
          finishSave = resolve;
        }),
    );
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest: vi.fn() },
    });

    await userEvent.click(button(panel, "Edit file"));
    const editor = panel.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.fill(editor, "submitted");
    await userEvent.click(button(panel, "Save"));
    await userEvent.fill(editor, "newer");
    finishSave?.({ ok: true, hash: "hash-2" });

    await expect.poll(() => button(panel, "Save").textContent?.trim()).toBe("Save");
    expect(button(panel, "Save").disabled).toBe(false);
    expect(editor.textContent).toContain("newer");
    await userEvent.click(button(panel, "Discard"));
  });

  it("restores an unsaved draft after the detail panel is closed", async () => {
    const originalEdit = { hash: "hash-1", save: vi.fn(), fetchLatest: vi.fn() };
    const first = await mountFile({
      kind: "file",
      draftKey: "session-a\u0000notes.txt",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: originalEdit,
    });

    await userEvent.click(button(first, "Edit file"));
    await userEvent.fill(first.querySelector<HTMLElement>(".cm-content")!, "unsaved draft");
    first.remove();

    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-3" });
    const reopened = await mountFile({
      kind: "file",
      draftKey: "session-a\u0000notes.txt",
      path: "notes.txt",
      name: "notes.txt",
      content: "latest",
      edit: { hash: "hash-2", save, fetchLatest: vi.fn() },
    });
    await expect
      .poll(() => reopened.querySelector(".cm-content")?.textContent)
      .toContain("unsaved");
    expect(reopened.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    expect(button(reopened, "Save").disabled).toBe(false);

    await userEvent.click(button(reopened, "Discard"));
    await userEvent.click(button(reopened, "Edit file"));
    await userEvent.fill(reopened.querySelector<HTMLElement>(".cm-content")!, "new edit");
    await userEvent.click(button(reopened, "Save"));
    await expect.poll(() => save.mock.calls.length).toBe(1);
    expect(save).toHaveBeenCalledWith({ content: "new edit", expectedHash: "hash-2" });
  });

  it("scopes retained drafts to the session file identity", async () => {
    const edit = { hash: "hash-1", save: vi.fn(), fetchLatest: vi.fn() };
    const first = await mountFile({
      kind: "file",
      draftKey: "gateway-a\u0000pane-left\u0000session-a\u0000shared.txt",
      path: "shared.txt",
      name: "shared.txt",
      content: "session a",
      edit,
    });

    await userEvent.click(button(first, "Edit file"));
    await userEvent.fill(first.querySelector<HTMLElement>(".cm-content")!, "session a draft");
    first.remove();

    const otherSession = await mountFile({
      kind: "file",
      draftKey: "gateway-a\u0000pane-right\u0000session-a\u0000shared.txt",
      path: "shared.txt",
      name: "shared.txt",
      content: "session b",
      edit,
    });
    expect(otherSession.querySelector(".cm-content")?.textContent).toContain("session b");
    expect(otherSession.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe(
      "false",
    );

    const restored = await mountFile({
      kind: "file",
      draftKey: "gateway-a\u0000pane-left\u0000session-a\u0000shared.txt",
      path: "shared.txt",
      name: "shared.txt",
      content: "session a",
      edit,
    });
    await expect.poll(() => restored.querySelector(".cm-content")?.textContent).toContain("draft");
    await userEvent.click(button(restored, "Discard"));
  });

  it("reloads the latest content after a save conflict", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, code: "conflict" });
    const fetchLatest = vi
      .fn()
      .mockResolvedValue({ content: "latest", hash: "hash-2", editable: true });
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest },
    });

    await userEvent.click(button(panel, "Edit file"));
    await userEvent.fill(panel.querySelector<HTMLElement>(".cm-content")!, "local");
    await userEvent.click(button(panel, "Save"));
    await expect
      .poll(() => panel.querySelector('[role="alert"]')?.textContent)
      .toContain("File changed on disk since it was loaded.");

    await userEvent.click(button(panel, "Reload"));
    await expect.poll(() => panel.querySelector(".cm-content")?.textContent).toContain("latest");
    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(button(panel, "Save").disabled).toBe(true);
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
      const panel = await mountFile({
        kind: "file",
        path: "notes.txt",
        name: "notes.txt",
        content: "before",
        edit: { hash: "hash-1", save, fetchLatest },
      });

      await userEvent.click(button(panel, "Edit file"));
      await userEvent.fill(panel.querySelector<HTMLElement>(".cm-content")!, "local");
      await userEvent.click(button(panel, "Save"));
      await expect.poll(() => panel.querySelector('[role="alert"]')).not.toBeNull();
      await userEvent.click(button(panel, "Reload"));

      await expect.poll(() => panel.querySelector(".cm-content")?.textContent).toContain("mixed");
      expect(panel.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
      expect(
        Array.from(panel.querySelectorAll("button")).some(
          (candidate) => candidate.getAttribute("aria-label") === "Edit file",
        ),
      ).toBe(false);
      expect(readFileDraft(panel.content)).toBeUndefined();
      panel.remove();
      expect(canReloadControlUiDocument()).toBe(true);
    },
  );

  it("makes the editor read-only while reloading a conflict", async () => {
    let finishReload:
      | ((latest: { content: string; hash: string; editable: boolean }) => void)
      | undefined;
    const save = vi.fn().mockResolvedValue({ ok: false, code: "conflict" });
    const fetchLatest = vi.fn().mockImplementation(
      () =>
        new Promise<{ content: string; hash: string; editable: boolean }>((resolve) => {
          finishReload = resolve;
        }),
    );
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest },
    });

    await userEvent.click(button(panel, "Edit file"));
    await userEvent.fill(panel.querySelector<HTMLElement>(".cm-content")!, "local");
    await userEvent.click(button(panel, "Save"));
    await expect
      .poll(() => panel.querySelector('[role="alert"]')?.textContent)
      .toContain("File changed on disk since it was loaded.");
    await userEvent.click(button(panel, "Reload"));

    await expect
      .poll(() => panel.querySelector(".cm-content")?.getAttribute("contenteditable"))
      .toBe("false");
    finishReload?.({ content: "latest", hash: "hash-2", editable: true });
    await expect.poll(() => panel.querySelector(".cm-content")?.textContent).toContain("latest");
    expect(panel.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
  });
});

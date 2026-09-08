import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../styles.css";
import "../../styles/settings.css";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { renderAgentFiles } from "./panels-status-files.ts";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  container.className = "settings-page";
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
});

function afterOwnHide(dialog: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const hidden = (event: Event) => {
      if (event.target !== dialog) {
        return;
      }
      dialog.removeEventListener("wa-after-hide", hidden);
      // The real dialog and adapter queue return focus before this observer's task.
      setTimeout(resolve, 0);
    };
    dialog.addEventListener("wa-after-hide", hidden);
  });
}

function requireButton(selector: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) {
    throw new Error(`Missing file-preview button: ${selector}`);
  }
  return button;
}

function mountAgentFile(content: string, onChange: (content: string) => void = () => undefined) {
  render(
    renderAgentFiles({
      agentId: "main",
      agentFilesList: {
        agentId: "main",
        workspace: "/synthetic/workspace",
        files: [{ name: "AGENTS.md", path: "/synthetic/workspace/AGENTS.md", missing: false }],
      },
      agentFilesLoading: false,
      agentFilesError: null,
      agentFileActive: "AGENTS.md",
      agentFileContents: { "AGENTS.md": "Saved instructions" },
      agentFileDrafts: { "AGENTS.md": content },
      agentFileSaving: false,
      canWrite: true,
      onLoadFiles: () => undefined,
      onSelectFile: () => undefined,
      onFileDraftChange: (_name, draft) => onChange(draft),
      onFileReset: () => undefined,
      onFileSave: () => undefined,
    }),
    container,
  );
}

describe.runIf(browserMode)("agent file preview viewport ownership", () => {
  it.each([
    [320, 568],
    [390, 844],
    [640, 800],
    [768, 1024],
    [844, 390],
    [1280, 800],
  ])("keeps the reader and close action inside the dialog at %sx%s", async (width, height) => {
    const { page, userEvent } = await import("vitest/browser");
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(width, height);
    try {
      mountAgentFile(
        "# Synthetic preview instructions\n\n" +
          "A long document must scroll without moving the preview controls.\n\n".repeat(80) +
          "[End of document](#preview-end)",
      );
      const preview = requireButton(".agent-file-actions button");
      const { modal, webAwesomeDialog, dialog } = await getRenderedModalDialog(container);
      const panel = container.querySelector<HTMLElement>(".md-preview-dialog__panel")!;
      const body = container.querySelector<HTMLElement>(".md-preview-dialog__body")!;
      const end = body.querySelector<HTMLAnchorElement>("a")!;
      const expand = requireButton(".md-preview-expand-btn");
      const close = requireButton('[aria-label="Close preview"]');
      preview.focus();
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => dialog.open).toBe(true);
      await Promise.all(dialog.getAnimations().map((animation) => animation.finished));

      for (const expanded of [false, true, false]) {
        if (expand.getAttribute("aria-pressed") !== String(expanded)) {
          await userEvent.click(expand);
          // The shell resizes immediately; its content must fit during the transition too.
          expect
            .soft(panel.getBoundingClientRect().bottom)
            .toBeLessThanOrEqual(dialog.getBoundingClientRect().bottom + 1);
          await Promise.all(panel.getAnimations().map((animation) => animation.finished));
        }
        const bounds = dialog.getBoundingClientRect();
        const content = panel.getBoundingClientRect();
        const action = close.getBoundingClientRect();
        // Test the actual shadow-DOM boundary, not a duplicated CSS height formula.
        expect.soft(content.top).toBeGreaterThanOrEqual(bounds.top - 1);
        expect.soft(content.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
        expect.soft(content.top).toBeGreaterThanOrEqual(0);
        expect.soft(content.bottom).toBeLessThanOrEqual(height + 1);
        expect(action.top).toBeGreaterThanOrEqual(0);
        expect(action.bottom).toBeLessThanOrEqual(height + 1);
        expect(body.clientHeight).toBeGreaterThan(0);
        expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
        body.scrollTop = body.scrollHeight;
        const lastLine = end.getBoundingClientRect();
        const reader = body.getBoundingClientRect();
        expect(lastLine.top).toBeGreaterThanOrEqual(reader.top - 1);
        expect(lastLine.bottom).toBeLessThanOrEqual(reader.bottom + 1);
        expect(close.getBoundingClientRect().top).toBe(action.top);
        expect(expand.getAttribute("aria-pressed")).toBe(String(expanded));
      }

      // Native keyboard traversal must reach the close action without scrolling chrome away.
      expand.focus();
      await userEvent.keyboard("{Tab}{Tab}");
      expect(document.activeElement).toBe(close);
      const closed = afterOwnHide(webAwesomeDialog);
      await userEvent.keyboard("{Enter}");
      await closed;
      expect(dialog.open).toBe(false);
      expect(document.activeElement).toBe(preview);
      expect(modal.isConnected).toBe(true);
    } finally {
      render(nothing, container);
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });
});

describe.runIf(browserMode)("agent file preview focus", () => {
  it.each(["edit", "close"] as const)(
    "returns focus to the intended owner after %s and retained reopen",
    async (action) => {
      const { userEvent } = await import("vitest/browser");
      const changes: string[] = [];
      let expectedDraft = "Unsaved file preview draft";
      mountAgentFile(expectedDraft, (content) => changes.push(content));
      const textarea = container.querySelector<HTMLTextAreaElement>(".agent-file-textarea");
      if (!textarea) {
        throw new Error("Missing agent file editor");
      }
      const preview = requireButton(".agent-file-actions button");
      const { modal, webAwesomeDialog, dialog } = await getRenderedModalDialog(container);
      expect(dialog.open).toBe(false);
      expect(textarea.value).toBe(expectedDraft);

      for (let opening = 0; opening < 2; opening += 1) {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        preview.focus();
        await userEvent.keyboard("{Enter}");
        await getRenderedModalDialog(container);
        await expect.poll(() => dialog.open).toBe(true);
        await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
        const closed = afterOwnHide(webAwesomeDialog);
        await userEvent.click(
          requireButton(
            action === "edit" ? '[aria-label="Edit file"]' : '[aria-label="Close preview"]',
          ),
        );
        await closed;
        expect(dialog.open).toBe(false);
        expect(modal.isConnected).toBe(true);

        if (action === "edit") {
          // Keyboard input must follow the returned focus; filling the locator would hide the bug.
          await userEvent.keyboard("-continued");
          expectedDraft += "-continued";
          expect(textarea.value).toBe(expectedDraft);
          expect(changes.at(-1)).toBe(expectedDraft);
          expect(document.activeElement).toBe(textarea);
        } else {
          expect(document.activeElement).toBe(preview);
          expect(textarea.value).toBe(expectedDraft);
          expect(changes).toEqual([]);
        }
      }
    },
  );
});

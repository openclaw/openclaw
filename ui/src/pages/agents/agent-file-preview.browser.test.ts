import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../styles.css";
import "../../styles/settings.css";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import { i18n } from "../../i18n/index.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { renderAgentFiles } from "./panels-status-files.ts";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLDivElement;
let tooltipProvider: HTMLElement;
let viewport: { width: number; height: number };

beforeEach(() => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  container = document.createElement("div");
  container.className = "settings-page";
  tooltipProvider = document.createElement("openclaw-tooltip-provider");
  tooltipProvider.append(container);
  document.body.append(tooltipProvider);
});

afterEach(async () => {
  render(nothing, container);
  tooltipProvider.remove();
  await i18n.setLocale("en");
  if (browserMode) {
    const { page } = await import("vitest/browser");
    await page.viewport(viewport.width, viewport.height);
  }
});

function afterOwnTransition(
  dialog: HTMLElement,
  eventName: "wa-after-show" | "wa-after-hide",
): Promise<void> {
  return new Promise((resolve) => {
    const completed = (event: Event) => {
      if (event.target !== dialog) {
        return;
      }
      dialog.removeEventListener(eventName, completed);
      // Dialog and adapter focus work completes before this observer's next task.
      setTimeout(resolve, 0);
    };
    dialog.addEventListener(eventName, completed);
  });
}

function requireButton(selector: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) {
    throw new Error(`Missing file-preview button: ${selector}`);
  }
  return button;
}

function renderPreview(draft: string, onChange = (_name: string, _content: string) => {}) {
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
      agentFileDrafts: { "AGENTS.md": draft },
      agentFileSaving: false,
      agentFileConflict: null,
      canWrite: true,
      onLoadFiles: () => undefined,
      onSelectFile: () => undefined,
      onFileDraftChange: onChange,
      onFileReset: () => undefined,
      onFileSave: () => undefined,
      onFileReload: () => undefined,
      onFileOverwrite: () => undefined,
    }),
    container,
  );
}

describe.runIf(browserMode)("agent file preview", () => {
  it.each(["edit", "close"] as const)(
    "returns focus to the intended owner after %s and retained reopen",
    async (action) => {
      const { userEvent } = await import("vitest/browser");
      const changes: string[] = [];
      let expectedDraft = "Unsaved file preview draft\n\n".repeat(80);
      renderPreview(expectedDraft, (_name, content) => changes.push(content));
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
        // Opening animations may start after dialog.open becomes true.
        const shown = afterOwnTransition(webAwesomeDialog, "wa-after-show");
        await userEvent.keyboard("{Enter}");
        await shown;
        expect(dialog.open).toBe(true);
        const panel = container.querySelector<HTMLElement>(".md-preview-dialog__panel")!;
        const body = container.querySelector<HTMLElement>(".md-preview-dialog__body")!;
        const bounds = dialog.getBoundingClientRect();
        expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(bounds.top - 1);
        expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom + 1);
        expect(body.clientHeight).toBeGreaterThan(0);
        expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
        const closed = afterOwnTransition(webAwesomeDialog, "wa-after-hide");
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
  it.each([
    [320, "ru"],
    [390, "en"],
    [1440, "en"],
  ] as const)(
    "keeps actions aligned and shows metadata by priority in each preview mode at %ipx (%s)",
    async (width, locale) => {
      const { page, userEvent } = await import("vitest/browser");
      await page.viewport(width, 900);
      await i18n.setLocale(locale);
      container.classList.add("shell--settings");
      renderPreview(
        "# Workspace operating instructions\n\n" + "Readable document content.\n\n".repeat(80),
      );
      const preview = requireButton(".agent-file-actions button");
      const { webAwesomeDialog, dialog } = await getRenderedModalDialog(container);
      const shown = afterOwnTransition(webAwesomeDialog, "wa-after-show");
      await userEvent.click(preview);
      await shown;
      expect(dialog.open).toBe(true);
      const identity = container.querySelector<HTMLElement>(".md-preview-dialog__header-main")!;
      const actions = container.querySelector<HTMLElement>(".md-preview-dialog__actions")!;
      const meta = container.querySelector<HTMLElement>(".md-preview-dialog__meta")!;
      const essentialChips = meta.querySelectorAll<HTMLDivElement>('[data-priority="essential"]');
      const secondaryMetadata = meta.querySelectorAll<HTMLElement>(
        '[data-priority="secondary"], .md-preview-dialog__chip > span',
      );
      expect(essentialChips).toHaveLength(3);
      expect(secondaryMetadata).toHaveLength(4);
      const body = container.querySelector<HTMLElement>(".md-preview-dialog__body")!;
      const normalInset = getComputedStyle(body).paddingInlineStart;
      for (const mode of ["normal", "fullscreen", "return"]) {
        if (mode !== "normal") {
          await userEvent.click(requireButton(".md-preview-expand-btn"));
        }
        await expect.poll(() => identity.getBoundingClientRect().width).toBeGreaterThan(1);
        const name = identity.getBoundingClientRect();
        const buttons = actions.getBoundingClientRect();
        expect(name.right).toBeLessThanOrEqual(buttons.left);
        expect(buttons.top).toBeLessThan(name.bottom);
        expect(buttons.bottom).toBeGreaterThan(name.top);
        expect(buttons.right).toBeLessThanOrEqual(dialog.getBoundingClientRect().right);
        for (const chip of essentialChips) {
          await expect.element(chip).toBeVisible();
        }
        for (const metadata of secondaryMetadata) {
          if (width <= 400) {
            await expect.element(metadata).not.toBeVisible();
          } else {
            await expect.element(metadata).toBeVisible();
          }
        }
        expect(getComputedStyle(body).paddingInlineStart).toBe(normalInset);
        body.scrollTop = body.scrollHeight;
        expect(body.scrollTop).toBeGreaterThan(0);
        body.scrollTop = 0;
      }
      if (width <= 400) {
        await page.viewport(1440, 900);
        for (const metadata of secondaryMetadata) {
          await expect.element(metadata).toBeVisible();
        }
      }
      const closed = afterOwnTransition(webAwesomeDialog, "wa-after-hide");
      await userEvent.keyboard("{Escape}");
      await closed;
      expect(dialog.open).toBe(false);
      expect(document.activeElement).toBe(preview);
    },
  );
});

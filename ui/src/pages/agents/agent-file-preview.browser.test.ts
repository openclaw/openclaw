import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import "../../styles.css";
import "../../styles/settings.css";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import { createAgentFileEditors } from "./agent-file-state.test-helpers.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import type { AgentFilesViewState } from "./files.ts";
import { AgentFiles } from "./panels-files.tsx";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLDivElement;
type Params = Parameters<typeof AgentFiles>[0] & AgentFilesViewState;

let mounted: ReturnType<typeof mountSolid<Parameters<typeof AgentFiles>[0]>> | undefined;
let tooltipProvider: HTMLElement;
let viewport: { width: number; height: number };

beforeEach(() => {
  mounted = undefined;
  viewport = { width: window.innerWidth, height: window.innerHeight };
  container = document.createElement("div");
  container.className = "settings-page";
  tooltipProvider = document.createElement("openclaw-tooltip-provider");
  tooltipProvider.append(container);
  document.body.append(tooltipProvider);
});

afterEach(async () => {
  mounted?.dispose();
  tooltipProvider.remove();
  await i18n.setLocale("en");
  if (browserMode) {
    const { page } = await import("vitest/browser");
    await page.viewport(viewport.width, viewport.height);
  }
});

function afterOwnTransition(
  dialog: HTMLElement,
  eventName: "overlay-after-show" | "overlay-after-hide",
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

function query<T extends Element = HTMLElement>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

function requireButton(selector: string): HTMLButtonElement {
  const button = query<HTMLButtonElement>(selector);
  if (!button) {
    throw new Error(`Missing file-preview button: ${selector}`);
  }
  return button;
}

function previewList(missing = false) {
  return {
    agentId: "main",
    workspace: "/synthetic/workspace",
    files: [{ name: "AGENTS.md", path: "/synthetic/workspace/AGENTS.md", missing }],
  };
}

function renderPreview(
  draft: string,
  onChange = (_name: string, _content: string) => {},
  overrides: Partial<Params> = {},
) {
  const base = createAgentViewTestProps();
  const props: Params = {
    ...base.readData(),
    ...base.agentFiles,
    readData() {
      return { ...base.readData(), ...this };
    },
    presentationRetired: base.presentationRetired,
    agentId: "main",
    agentFilesList: previewList(),
    agentFileActive: "AGENTS.md",
    canWrite: true,
    onFileDraftChange: (name, content) => {
      onChange(name, content);
      renderPreview(content, onChange, overrides);
    },
    ...overrides,
    agentFileEditors: {
      "AGENTS.md": {
        content: "Saved instructions",
        draft,
        ...overrides.agentFileEditors?.["AGENTS.md"],
      },
    },
  };
  if (mounted) {
    mounted.update(props);
  } else {
    mounted = mountSolid(AgentFiles, props, container);
  }
}

describe.runIf(browserMode)("agent file preview", () => {
  it.each([
    [false, null, "Saved Preview", "Updated Unknown"],
    [true, null, "Will Create on Save", "Not Created Yet"],
    [true, "AGENTS.md", "Live Draft Preview", "Updated Unknown"],
    [true, "SOUL.md", "Will Create on Save", "Not Created Yet"],
  ] as const)(
    "opens a sanitized document with current metadata (missing %s, conflict %s)",
    async (missing, conflict, status, updated) => {
      const { userEvent } = await import("vitest/browser");
      const draft =
        "# User Profile\n\nHello world\n\n```ts\nconst answer = 42;\n```\n\n<script>alert(1)</script>\n\n![Remote](https://example.invalid/image.png)";
      renderPreview(draft, undefined, {
        agentFilesList: previewList(missing),
        agentFileEditors: createAgentFileEditors({
          content: { "AGENTS.md": draft },
        }),
        agentFileConflict: conflict,
      });
      const { modal } = await getRenderedModalDialog(container);
      const shown = afterOwnTransition(modal, "overlay-after-show");
      await userEvent.click(requireButton(".agent-file-header .agent-file-actions button"));
      await shown;
      expect(query(".md-preview-dialog__path")?.textContent?.trim()).toBe("AGENTS.md");
      expect(query(".md-preview-dialog__chip strong")?.textContent).toBe(status);
      expect(query(".md-preview-dialog__meta")?.textContent).toContain(updated);
      const reader = query(".md-preview-dialog__reader")!;
      expect(reader.querySelector("img")?.getAttribute("src")).toBe(
        "https://example.invalid/image.png",
      );
      expect(reader.querySelector("pre code")?.textContent).toBe("const answer = 42;\n");
      expect(reader.querySelector(".code-block-copy, script")).toBeNull();
      expect(requireButton(".md-preview-expand-btn").getAttribute("aria-label")).toBe(
        "Expand preview",
      );
      const closed = afterOwnTransition(modal, "overlay-after-hide");
      await userEvent.keyboard("{Escape}");
      await closed;
    },
  );
  it.each(["edit", "close"] as const)(
    "returns focus to the intended owner after %s and retained reopen",
    async (action) => {
      const { userEvent } = await import("vitest/browser");
      const changes: string[] = [];
      let expectedDraft = "Unsaved file preview draft\n\n".repeat(80);
      renderPreview(expectedDraft, (_name, content) => changes.push(content));
      const textarea = query<HTMLTextAreaElement>(".agent-file-textarea");
      if (!textarea) {
        throw new Error("Missing agent file editor");
      }
      const preview = requireButton(".agent-file-header .agent-file-actions button");
      const { modal, dialog } = await getRenderedModalDialog(container);
      expect(dialog.open).toBe(false);
      expect(textarea.value).toBe(expectedDraft);
      let hiddenMutations = 0;
      const observer = new MutationObserver((records) => {
        if (!modal.open) {
          hiddenMutations += records.length;
        }
      });
      observer.observe(modal, { childList: true, subtree: true, characterData: true });

      for (let opening = 0; opening < 2; opening += 1) {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        preview.focus();
        // Opening animations may start after dialog.open becomes true.
        const shown = afterOwnTransition(modal, "overlay-after-show");
        await userEvent.keyboard("{Enter}");
        await shown;
        expect(dialog.open).toBe(true);
        expect(query(".md-preview-dialog__reader")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
          expectedDraft.replace(/\s+/g, " ").trim(),
        );
        const panel = query(".md-preview-dialog__panel")!;
        const body = query(".md-preview-dialog__body")!;
        const bounds = dialog.getBoundingClientRect();
        expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(bounds.top - 1);
        expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom + 1);
        expect(body.clientHeight).toBeGreaterThan(0);
        expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
        const expand = requireButton(".md-preview-expand-btn");
        expect(expand.getAttribute("aria-pressed")).toBe("false");
        expect(panel.classList.contains("fullscreen")).toBe(false);
        await userEvent.click(expand);
        expect(expand.getAttribute("aria-pressed")).toBe("true");
        expect(expand.getAttribute("aria-label")).toBe("Collapse preview");
        expect(panel.classList.contains("fullscreen")).toBe(true);
        expect(modal.classList.contains("fullscreen")).toBe(true);
        const closed = afterOwnTransition(modal, "overlay-after-hide");
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
          expect(hiddenMutations).toBe(0);
        } else {
          expect(document.activeElement).toBe(preview);
          expect(textarea.value).toBe(expectedDraft);
          expect(changes).toEqual([]);
        }
      }
      observer.disconnect();
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
      const preview = requireButton(".agent-file-header .agent-file-actions button");
      const { modal, dialog } = await getRenderedModalDialog(container);
      const shown = afterOwnTransition(modal, "overlay-after-show");
      await userEvent.click(preview);
      await shown;
      expect(dialog.open).toBe(true);
      const identity = query(".md-preview-dialog__header-main")!;
      const actions = query(".md-preview-dialog__actions")!;
      const meta = query(".md-preview-dialog__meta")!;
      const essentialChips = meta.querySelectorAll<HTMLDivElement>('[data-priority="essential"]');
      const secondaryMetadata = meta.querySelectorAll<HTMLElement>(
        '[data-priority="secondary"], .md-preview-dialog__chip > span',
      );
      expect(essentialChips).toHaveLength(3);
      expect(secondaryMetadata).toHaveLength(4);
      const body = query(".md-preview-dialog__body")!;
      const normalInset = getComputedStyle(body).paddingInlineStart;
      const footer = query(".md-preview-dialog__footer")!;
      const edit = footer.querySelector<HTMLButtonElement>("button")!;
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
        const footerTop = footer.getBoundingClientRect().top;
        expect(footerTop).toBeGreaterThanOrEqual(body.getBoundingClientRect().bottom - 1);
        expect(edit.getBoundingClientRect().right).toBeLessThanOrEqual(
          dialog.getBoundingClientRect().right,
        );
        expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          dialog.getBoundingClientRect().bottom + 1,
        );
        await expect.element(edit).toBeVisible();
        body.scrollTop = body.scrollHeight;
        expect(footer.getBoundingClientRect().top).toBe(footerTop);
        expect(body.scrollTop).toBeGreaterThan(0);
        body.scrollTop = 0;
      }
      if (width <= 400) {
        await page.viewport(1440, 900);
        for (const metadata of secondaryMetadata) {
          await expect.element(metadata).toBeVisible();
        }
      }
      const closed = afterOwnTransition(modal, "overlay-after-hide");
      await userEvent.keyboard("{Escape}");
      await closed;
      expect(dialog.open).toBe(false);
      expect(document.activeElement).toBe(preview);
    },
  );
});

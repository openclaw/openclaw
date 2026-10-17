import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import "../../styles.css";
import "../../styles/settings.css";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { AgentFiles } from "./panels-files.tsx";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLDivElement;
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

async function previewHarness() {
  const { userEvent } = await import("vitest/browser");
  const { modal, dialog } = await getRenderedModalDialog(container);
  const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!;
  const part = (name: string) =>
    container.querySelector<HTMLElement>(`.md-preview-dialog__${name}`)!;
  const preview = button(".agent-file-header .agent-file-actions button");
  async function transition(show: boolean, effect: () => Promise<unknown>) {
    const eventName = show ? "overlay-after-show" : "overlay-after-hide";
    const completed = new Promise<void>((resolve) => {
      const listener = (event: Event) => {
        if (event.target !== modal) {
          return;
        }
        modal.removeEventListener(eventName, listener);
        // Dialog and adapter focus work completes before this observer's next task.
        setTimeout(resolve, 0);
      };
      modal.addEventListener(eventName, listener);
    });
    await effect();
    await completed;
  }
  return { userEvent, modal, dialog, button, part, preview, transition };
}

function renderPreview(
  draft: string,
  onChange = (_name: string, _content: string) => {},
  options: { missing?: boolean; saved?: boolean; conflict?: string | null } = {},
) {
  const { missing = false, saved = false, conflict = null } = options;
  const props: Parameters<typeof AgentFiles>[0] = {
    agentId: "main",
    agentFilesList: {
      agentId: "main",
      workspace: "/synthetic/workspace",
      files: [{ name: "AGENTS.md", path: "/synthetic/workspace/AGENTS.md", missing }],
    },
    agentFilesLoading: false,
    agentFilesError: null,
    agentFileActive: "AGENTS.md",
    agentFileSaving: false,
    agentFileConflict: conflict,
    canWrite: true,
    onLoadFiles: () => undefined,
    onSelectFile: () => undefined,
    onFileDraftChange: (name, content) => {
      onChange(name, content);
      renderPreview(content, onChange, options);
    },
    onFileReset: () => undefined,
    onFileSave: () => undefined,
    onFileReload: () => undefined,
    onFileOverwrite: () => undefined,
    agentFileEditors: { "AGENTS.md": { content: saved ? draft : "Saved instructions", draft } },
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
      const draft =
        "# User Profile\n\nHello world\n\n```ts\nconst answer = 42;\n```\n\n<script>alert(1)</script>\n\n![Remote](https://example.invalid/image.png)";
      renderPreview(draft, undefined, { missing, conflict, saved: true });
      const { userEvent, preview, part, transition } = await previewHarness();
      await transition(true, () => userEvent.click(preview));
      expect([
        part("path").textContent?.trim(),
        part("chip strong").textContent,
        part("eyebrow span").textContent?.trim(),
      ]).toEqual(["AGENTS.md", status, "Markdown Preview"]);
      expect(part("meta").textContent).toContain(updated);
      const reader = part("reader");
      expect(reader.querySelector("img")?.getAttribute("src")).toBe(
        "https://example.invalid/image.png",
      );
      expect(reader.querySelector("pre code")?.textContent).toBe("const answer = 42;\n");
      expect(reader.querySelector(".code-block-copy, script")).toBeNull();
      const actions = Array.from(part("actions").querySelectorAll("button"));
      expect(
        actions.map((button) => [button.getAttribute("aria-label"), button.textContent?.trim()]),
      ).toEqual([
        ["Expand preview", ""],
        ["Close preview", ""],
      ]);
      const footer = container.querySelector("openclaw-modal-actions.md-preview-dialog__footer");
      expect(footer?.parentElement?.lastElementChild).toBe(footer);
      expect(footer?.querySelector("button")?.textContent?.trim()).toBe("Edit file");
      await transition(false, () => userEvent.keyboard("{Escape}"));
    },
  );
  it.each(["edit", "close"] as const)(
    "returns focus to the intended owner after %s and retained reopen",
    async (action) => {
      const changes: string[] = [];
      let expectedDraft = "Unsaved file preview draft\n\n".repeat(80);
      renderPreview(expectedDraft, (_name, content) => changes.push(content));
      const textarea = container.querySelector<HTMLTextAreaElement>(".agent-file-textarea")!;
      const { userEvent, modal, dialog, preview, part, button, transition } =
        await previewHarness();
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
        await transition(true, () => userEvent.keyboard("{Enter}"));
        expect(dialog.open).toBe(true);
        expect(part("reader").textContent?.replace(/\s+/g, " ").trim()).toBe(
          expectedDraft.replace(/\s+/g, " ").trim(),
        );
        const panel = part("panel");
        const body = part("body");
        const bounds = dialog.getBoundingClientRect();
        expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(bounds.top - 1);
        expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom + 1);
        expect(body.clientHeight).toBeGreaterThan(0);
        expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
        await transition(false, () =>
          userEvent.click(
            button(action === "edit" ? '[aria-label="Edit file"]' : '[aria-label="Close preview"]'),
          ),
        );
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
      const { page } = await import("vitest/browser");
      await page.viewport(width, 900);
      await i18n.setLocale(locale);
      container.classList.add("shell--settings");
      renderPreview(
        "# Workspace operating instructions\n\n" + "Readable document content.\n\n".repeat(80),
      );
      const { userEvent, dialog, preview, part, button, transition } = await previewHarness();
      await transition(true, () => userEvent.click(preview));
      expect(dialog.open).toBe(true);
      const identity = part("header-main");
      const actions = part("actions");
      const meta = part("meta");
      const essentialChips = meta.querySelectorAll<HTMLDivElement>('[data-priority="essential"]');
      const secondaryMetadata = meta.querySelectorAll<HTMLElement>(
        '[data-priority="secondary"], .md-preview-dialog__chip > span',
      );
      expect(essentialChips).toHaveLength(3);
      expect(secondaryMetadata).toHaveLength(4);
      const body = part("body");
      const normalInset = getComputedStyle(body).paddingInlineStart;
      const footer = part("footer");
      const edit = footer.querySelector<HTMLButtonElement>("button")!;
      for (const mode of ["normal", "fullscreen", "return"]) {
        if (mode !== "normal") {
          await userEvent.click(button(".md-preview-expand-btn"));
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
      await transition(false, () => userEvent.keyboard("{Escape}"));
      expect(dialog.open).toBe(false);
      expect(document.activeElement).toBe(preview);
    },
  );
});

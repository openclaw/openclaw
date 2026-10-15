import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTitleTooltips } from "../../../components/tooltip-title.ts";
import "../../../components/web-awesome.ts";
import { i18n } from "../../../i18n/index.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../../lib/keyboard-shortcut-contract.ts";
import {
  openChatLayoutMenu,
  selectChatLayoutAction,
} from "../../../test-helpers/chat-layout-menu.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import "../../../styles.css";
import "../../../styles/chat/startup-layout.css";
import "../../../styles/chat/layout.css";
import "../../../styles/chat/split-view.css";
import { openSlot, setSidebarOpen } from "../sidebar-layout.ts";
import type { ChatDetails } from "./chat-details.tsx";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";
import "./chat-details.tsx";
import { ChatSidebarEditorMenu } from "./chat-sidebar-editor-menu.tsx";

describe.skipIf(typeof HTMLElement.prototype.checkVisibility !== "function")(
  "chat pane branch tooltip positioning",
  () => {
    const containers: HTMLElement[] = [];
    let dispose: () => void;
    let page: (typeof import("vitest/browser"))["page"];

    beforeEach(async () => {
      ({ page } = await import("vitest/browser"));
      await page.viewport(1200, 800);
      await i18n.setLocale("en");
      dispose = installTitleTooltips(document);
    });

    afterEach(() => {
      dispose();
      containers.splice(0).forEach((container) => container.remove());
    });

    it("opens the labelled Layout menu and dispatches focus, swap, docking, and panel choices", async () => {
      const onLayoutChange = vi.fn();
      const onBrowser = vi.fn();
      const layout = openSlot({ columns: [] }, "subagents");
      const { container } = mountChatPaneHeader(containers, {
        sidebarLayout: layout,
        onLayoutChange,
        onToggleSidePanel: vi.fn(),
        panelDefinitions: [
          {
            slot: "conversation",
            label: "Chat",
            icon: html``,
            available: true,
            content: null,
            loading: html``,
            empty: { description: "" },
          },
          {
            slot: "subagents",
            label: "Subagents",
            icon: html``,
            available: true,
            content: null,
            loading: html``,
            empty: { description: "" },
          },
        ],
        panelMenuActions: [
          {
            id: "browser",
            label: "Toggle browser panel",
            icon: html``,
            shortcut: KEYBOARD_SHORTCUT_COMBOS.browserPanel,
            onActivate: onBrowser,
          },
        ],
      });
      for (const label of [
        "Focus",
        "Swap Chat and Subagents",
        "Move side panel below",
        "Toggle browser panel",
      ]) {
        if (label === "Toggle browser panel") {
          expect(container.querySelector('[value="browser"] kbd')?.textContent).toContain("U");
        }
        await selectChatLayoutAction(
          { container, click: (element: HTMLElement) => page.elementLocator(element).click() },
          label,
        );
      }
      expect(onLayoutChange.mock.calls[0]?.[0].expanded).toBe(true);
      expect(onLayoutChange.mock.calls[1]?.[0].mainPanelId).toBe("subagents");
      expect(onLayoutChange.mock.calls[2]?.[0].dock).toBe("bottom");
      expect(onBrowser).toHaveBeenCalledOnce();
    });

    it("closes Layout before changing its contents and restores focus on selection and Escape", async () => {
      const { userEvent } = await import("vitest/browser");
      const observations: Array<{ open: boolean; focused: boolean }> = [];
      const fixture: ReturnType<typeof mountChatPaneHeader> = mountChatPaneHeader(containers, {
        sidebarLayout: openSlot({ columns: [] }, "subagents"),
        onToggleSidePanel: () => {
          const menu = fixture.container.querySelector(".chat-pane__layout-menu")!;
          const trigger = menu.querySelector("button")!;
          observations.push({
            open: menu.hasAttribute("open"),
            focused: document.activeElement === trigger,
          });
          fixture.update({
            sidebarLayout: setSidebarOpen(
              fixture.props.sidebarLayout!,
              !fixture.props.sidebarLayout!.open,
            ),
          });
        },
      });
      const trigger = fixture.container.querySelector<HTMLButtonElement>(
        ".chat-pane__layout-trigger",
      )!;
      const menu =
        fixture.container.querySelector<HTMLElementTagNameMap["wa-dropdown"]>(
          ".chat-pane__layout-menu",
        )!;
      const shown = vi.fn();
      menu.addEventListener("wa-after-show", shown, { once: true });
      await openChatLayoutMenu({
        container: fixture.container,
        click: (element: HTMLElement) => page.elementLocator(element).click(),
      });
      expect(shown).toHaveBeenCalledOnce();
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => menu.hasAttribute("open")).toBe(false);
      expect(document.activeElement).toBe(trigger);
      for (const label of ["Minimize side panel", "Side panel"]) {
        await selectChatLayoutAction(
          {
            container: fixture.container,
            click: (element: HTMLElement) => page.elementLocator(element).click(),
          },
          label,
        );
        expect(document.activeElement).toBe(trigger);
      }
      const transitions: Array<{ type: string; open: boolean; callbacks: number }> = [];
      const events = ["wa-show", "wa-after-show", "wa-select", "wa-hide", "wa-after-hide"];
      const recordTransition = (event: Event) => {
        transitions.push({ type: event.type, open: menu.open, callbacks: observations.length });
      };
      for (const event of events) {
        menu.addEventListener(event, recordTransition);
      }
      try {
        for (const expectedCount of [3, 4]) {
          trigger.click();
          menu.querySelector<HTMLElement>('[value="side-panel"]')!.click();
          await expect.poll(() => observations.length).toBe(expectedCount);
          expect(menu.hasAttribute("open")).toBe(false);
          expect(document.activeElement).toBe(trigger);
        }
        expect(observations).toEqual([
          { open: false, focused: true },
          { open: false, focused: true },
          { open: false, focused: true },
          { open: false, focused: true },
        ]);
      } catch (error) {
        console.error("Layout selection lifecycle", {
          transitions,
          open: menu.open,
          popupActive: menu.shadowRoot?.querySelector("wa-popup")?.active,
          focused: document.activeElement === trigger,
          callbacks: observations.length,
        });
        throw error;
      } finally {
        for (const event of events) {
          menu.removeEventListener(event, recordTransition);
        }
      }
    });

    it.each([320, 693])(
      "keeps a running batch and all controls inside a %ipx header",
      async (width) => {
        await page.viewport(width, 800);
        const onTerminal = vi.fn();
        const { container } = mountChatPaneHeader(containers, {
          narrow: true,
          runningSubagentCount: 12,
          panelMenuActions: [
            {
              id: "terminal",
              label: "Toggle terminal",
              icon: html``,
              shortcut: KEYBOARD_SHORTCUT_COMBOS.terminalPanel,
              onActivate: onTerminal,
            },
          ],
          detailsControl: html`<openclaw-chat-details .presented=${true}></openclaw-chat-details>`,
          sidebarLayout: { columns: [] },
          onLayoutChange: vi.fn(),
          onToggleSidePanel: vi.fn(),
          sharingControl: html`<button
            class="btn btn--ghost chat-pane__sharing-trigger"
            aria-label="Share"
          >
            Share
          </button>`,
          sessionMenuAction: html`<button
            class="btn btn--ghost chat-icon-btn"
            aria-label="Session actions"
          >
            …
          </button>`,
        });
        container.style.width = `${width}px`;
        const header = container.querySelector<HTMLElement>(".chat-pane__header")!;
        await container.querySelector<ChatDetails>("openclaw-chat-details")?.updateComplete;
        await expect.element(page.elementLocator(header)).toBeVisible();
        expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
        const bounds = header.getBoundingClientRect();
        for (const selector of [
          ".chat-details-toggle",
          '[aria-label="Share"]',
          ".chat-pane__layout-trigger",
          '[aria-label="Session actions"]',
        ]) {
          const button = container.querySelector<HTMLElement>(selector)!;
          expect(button.checkVisibility()).toBe(true);
          expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
        }
        expect(container.querySelector(".chat-pane__subagents-running")?.textContent).toContain(
          "Subagents · 12 running",
        );
        const scope = {
          container,
          click: (element: HTMLElement) => page.elementLocator(element).click(),
        };
        const menu = await openChatLayoutMenu(scope);
        const shortcut = menu.querySelector<HTMLElement>("kbd")!;
        expect(shortcut.checkVisibility()).toBe(false);
        const surface = menu.shadowRoot!.querySelector<HTMLElement>("[role=menu]")!;
        expect(surface.getBoundingClientRect().width).toBeLessThanOrEqual(264);
        await selectChatLayoutAction(scope, "Toggle terminal");
        expect(onTerminal).toHaveBeenCalledOnce();
      },
    );

    it.each(["idle", "busy", "editor"] as const)(
      "anchors the %s hint to its menu button",
      async (state) => {
        const busy = state === "busy";
        const editor = state === "editor";
        const onOpenEditor = vi.fn();
        const reason = "Branch switch is unavailable while the agent is working.";
        const { container, props, unmount } = mountChatPaneHeader(containers, {
          branchSwitchDisabledReason: busy ? reason : null,
          onClosePane: state === "idle" ? vi.fn() : undefined,
          branches: [
            { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
            { leafEntryId: "other", headline: "Earlier idea", messageCount: 2, active: false },
          ],
        });
        if (editor) {
          unmount();
          mountSolid(
            () => (
              <ChatSidebarEditorMenu
                absolutePath="/repo/example.ts"
                open={false}
                onOpenChange={() => undefined}
                onOpenEditor={onOpenEditor}
              />
            ),
            { container },
          );
        }
        container.style.cssText =
          state === "idle"
            ? "position: fixed; top: 80px; left: 80px; width: 1000px"
            : "position: fixed; top: 80px; left: 500px; width: 650px";
        await container.querySelector("openclaw-chat-pane-versions-menu")?.updateComplete;
        const trigger = container.querySelector<HTMLButtonElement>(
          editor ? ".sidebar-file-view__action" : ".chat-pane__branches-trigger",
        )!;
        await page.elementLocator(trigger).hover();
        const tooltip = () =>
          [...document.querySelectorAll("openclaw-tooltip")]
            .map((element) => element.shadowRoot?.querySelector<HTMLElement>(".tooltip-surface"))
            .find((element) => element?.matches(":popover-open"));
        await expect
          .poll(() => tooltip()?.textContent)
          .toContain(editor ? "Open in editor" : busy ? reason : "Versions");
        await expect
          .poll(() => {
            const body = tooltip();
            if (!body) {
              return false;
            }
            const hint = body.getBoundingClientRect();
            const button = trigger.getBoundingClientRect();
            return (
              hint.width > 0 &&
              hint.left < button.right &&
              hint.right > button.left &&
              Math.min(Math.abs(hint.bottom - button.top), Math.abs(hint.top - button.bottom)) < 24
            );
          })
          .toBe(true);

        if (!busy) {
          await page.elementLocator(trigger).click();
          await expect.poll(() => tooltip()).toBeUndefined();
          await page.getByRole("menuitem", { name: editor ? "VS Code" : /Earlier idea/ }).click();
          expect(editor ? onOpenEditor : props.onBranchSelect).toHaveBeenCalledWith(
            editor ? "vscode" : "other",
          );
        }

        if (state === "idle") {
          const header = container.querySelector<HTMLElement>(".chat-pane__header")!;
          const layout = container.querySelector<HTMLButtonElement>(".chat-pane__layout-trigger")!;
          for (const width of [320, 693]) {
            container.style.width = `${width}px`;
            expect(trigger.checkVisibility()).toBe(true);
            const bounds = header.getBoundingClientRect();
            const branchBounds = trigger.getBoundingClientRect();
            const closeBounds = layout.getBoundingClientRect();
            expect(branchBounds.left).toBeGreaterThanOrEqual(bounds.left);
            expect(branchBounds.right).toBeLessThanOrEqual(closeBounds.left);
            expect(closeBounds.right).toBeLessThanOrEqual(bounds.right);
            expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
            vi.mocked(props.onBranchSelect).mockClear();
            await page.elementLocator(trigger).click();
            await page.getByRole("menuitem", { name: /Earlier idea/ }).click();
            expect(props.onBranchSelect).toHaveBeenCalledExactlyOnceWith("other");
          }
          await selectChatLayoutAction(
            { container, click: (element: HTMLElement) => page.elementLocator(element).click() },
            "Close pane",
          );
          expect(props.onClosePane).toHaveBeenCalledExactlyOnceWith("pane-1");
        }
      },
    );
  },
);

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { installTitleTooltips } from "../../../components/tooltip-title.ts";
import { i18n, t } from "../../../i18n/index.ts";
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
import {
  chatPaneHeaderSharing,
  chatPaneHeaderSessionMenu,
  mountChatPaneHeader,
} from "./chat-pane-header.test-support.ts";
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
            icon: "copy",
            available: true,
            content: null,
            loading: { variant: "files", label: "Loading" },
            empty: { description: "" },
          },
          {
            slot: "subagents",
            label: "Subagents",
            icon: "copy",
            available: true,
            content: null,
            loading: { variant: "files", label: "Loading" },
            empty: { description: "" },
          },
        ],
        panelMenuActions: [
          {
            id: "browser",
            label: "Toggle browser panel",
            icon: "copy",
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
          expect(container.querySelector('[data-value="browser"] kbd')?.textContent).toContain("U");
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

    it.each(["ltr", "rtl"])(
      "keeps mobile tool choices separate from session details in %s",
      async (direction) => {
        await page.viewport(390, 844);
        const originalDirection = document.documentElement.dir;
        onTestFinished(() => {
          document.documentElement.dir = originalDirection;
        });
        document.documentElement.dir = direction;
        const onTerminal = vi.fn();
        const { container } = mountChatPaneHeader(containers, {
          mergedChrome: true,
          narrow: true,
          panelMenuActions: [
            {
              id: "terminal",
              label: "Terminal",
              icon: "copy",
              shortcut: KEYBOARD_SHORTCUT_COMBOS.terminalPanel,
              onActivate: onTerminal,
            },
            ...Array.from({ length: 7 }, (_, index) => ({
              id: `panel-${index + 1}`,
              label: `Panel ${index + 1}`,
              icon: "copy" as const,
              onActivate: vi.fn(),
            })),
          ],
          onOpenSplitView: vi.fn(),
        });
        const scope = {
          container,
          click: (element: HTMLElement) => page.elementLocator(element).click(),
        };
        const menu = await openChatLayoutMenu(scope);
        const trigger = menu.querySelector<HTMLButtonElement>(".chat-pane__layout-trigger")!;
        expect(trigger.getAttribute("aria-label")).toBe(t("chat.sessionHeader.panels"));
        expect(trigger.textContent?.trim()).toBe("");
        expect(
          [...menu.querySelectorAll("[role^=menuitem]")].map((item) =>
            item.getAttribute("data-value"),
          ),
        ).toEqual([
          "terminal",
          "panel-1",
          "panel-2",
          "panel-3",
          "panel-4",
          "panel-5",
          "panel-6",
          "panel-7",
          "open-split-view",
        ]);
        const surface = menu.querySelector<HTMLElement>(":scope > .oc-menu")!;
        // Measure the settled surface, not its opening scale transition.
        await Promise.all(surface.getAnimations().map((animation) => animation.finished));
        const bounds = surface.getBoundingClientRect();
        expect(bounds.width).toBeCloseTo(264, 0);
        // The phone menu opens from its header trigger, not a viewport corner.
        const anchor = trigger.getBoundingClientRect();
        expect(direction === "ltr" ? bounds.right : bounds.left).toBeCloseTo(
          direction === "ltr" ? anchor.right : anchor.left,
          0,
        );
        expect(bounds.top).toBeGreaterThanOrEqual(anchor.bottom);
        expect(bounds.top - anchor.bottom).toBeLessThanOrEqual(12);
        expect(bounds.height).toBeCloseTo(360, 0);
        expect(surface.scrollHeight).toBeGreaterThan(surface.clientHeight);
        const terminalDetails = surface.querySelector<HTMLElement>(
          '[data-value="terminal"] > .oc-menu-item__details',
        )!;
        expect(terminalDetails.querySelector("kbd")).not.toBeNull();
        expect(getComputedStyle(terminalDetails).display).toBe("none");
        await selectChatLayoutAction(scope, "Terminal");
        expect(onTerminal).toHaveBeenCalledOnce();
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
      },
    );

    it("keeps local Details reachable when the mobile session menu is unavailable", async () => {
      await page.viewport(390, 844);
      const onOpenDetails = vi.fn();
      const fixture = mountChatPaneHeader(containers, {
        mergedChrome: true,
        narrow: true,
        session: undefined,
        onOpenDetails,
      });
      const trigger = fixture.container.querySelector<HTMLButtonElement>(".chat-details-toggle")!;
      await page.elementLocator(trigger).click();
      expect(onOpenDetails).toHaveBeenCalledWith(trigger);
      fixture.update({ session: { key: "agent:main:main", kind: "direct", updatedAt: 0 } });
      expect(fixture.container.querySelector(".chat-details-toggle")).toBeNull();
    });

    it("closes Layout before changing its contents and restores focus on selection and Escape", async () => {
      const observations: Array<{ open: boolean; focused: boolean }> = [];
      const fixture: ReturnType<typeof mountChatPaneHeader> = mountChatPaneHeader(containers, {
        sidebarLayout: openSlot({ columns: [] }, "subagents"),
        onToggleSidePanel: () => {
          const menu = fixture.container.querySelector(".chat-pane__layout-menu")!;
          const trigger = menu.querySelector("button")!;
          observations.push({
            open: trigger.getAttribute("aria-expanded") === "true",
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
      const menu = fixture.container.querySelector(".chat-pane__layout-menu")!;
      const surface = menu.querySelector<HTMLElement>('[role="menu"]')!;
      const shown = vi.fn();
      surface.addEventListener("overlay-after-show", shown, { once: true });
      await openChatLayoutMenu({
        container: fixture.container,
        click: (element: HTMLElement) => page.elementLocator(element).click(),
      });
      expect(shown).toHaveBeenCalledOnce();
      const closingAnimation = surface.animate({ opacity: [1, 0.9] }, { duration: 1000 });
      closingAnimation.pause();
      onTestFinished(() => closingAnimation.cancel());
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(surface.dataset.phase).toBe("closing");
      expect(surface.matches(":popover-open")).toBe(true);
      expect(document.activeElement).toBe(trigger);
      closingAnimation.cancel();
      await openChatLayoutMenu({
        container: fixture.container,
        click: (element: HTMLElement) => page.elementLocator(element).click(),
      });
      expect(surface.dataset.phase).toBe("open");
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
      for (const expectedCount of [3, 4]) {
        const hidden = new Promise<Event>((resolve) => {
          surface.addEventListener("overlay-after-hide", resolve, { once: true });
        });
        await page.elementLocator(trigger).click();
        await page
          .elementLocator(menu.querySelector<HTMLElement>('[data-value="side-panel"]')!)
          .click();
        expect((await hidden).target).toBe(surface);
        expect(observations).toHaveLength(expectedCount);
        expect(surface.matches(":popover-open")).toBe(false);
        expect(document.activeElement).toBe(trigger);
      }
      expect(observations).toEqual([
        { open: false, focused: true },
        { open: false, focused: true },
        { open: false, focused: true },
        { open: false, focused: true },
      ]);
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
              icon: "copy",
              shortcut: KEYBOARD_SHORTCUT_COMBOS.terminalPanel,
              onActivate: onTerminal,
            },
          ],
          detailsControl: { chat: undefined, mobile: false, presentation: true, setRef: () => {} },
          sidebarLayout: { columns: [] },
          onLayoutChange: vi.fn(),
          onToggleSidePanel: vi.fn(),
          sharingControl: chatPaneHeaderSharing(),
          sessionMenuAction: chatPaneHeaderSessionMenu(),
        });
        container.style.width = `${width}px`;
        const header = container.querySelector<HTMLElement>(".chat-pane__header")!;
        await container.querySelector<ChatDetails>("openclaw-chat-details")?.updateComplete;
        await expect.element(page.elementLocator(header)).toBeVisible();
        expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
        const bounds = header.getBoundingClientRect();
        for (const selector of [
          ".chat-details-toggle",
          ".chat-pane__sharing-trigger",
          ".chat-pane__layout-trigger",
          ".chat-header-session-menu__trigger",
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
        const surface = menu.querySelector<HTMLElement>("[role=menu]")!;
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

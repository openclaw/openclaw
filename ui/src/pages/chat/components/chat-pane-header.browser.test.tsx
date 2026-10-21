import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { installTitleTooltips } from "../../../components/tooltip-title.ts";
import { i18n, t } from "../../../i18n/index.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../../lib/keyboard-shortcut-contract.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "../../../styles.css";
import "../../../styles/chat/startup-layout.css";
import "../../../styles/chat/layout.css";
import "../../../styles/chat/split-view.css";
import { sidebarPanelDefinitions } from "../chat-pane-embedded-panels.ts";
import { openSlot, setSidebarOpen } from "../sidebar-layout.ts";
import {
  chatPaneHeaderSharing,
  chatPaneHeaderSessionMenu,
  mountChatPaneHeader,
} from "./chat-pane-header.test-support.ts";
import { DesktopFrameControls } from "./chat-sidebar-desktop-frame-controls.tsx";
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

    // Compact and catalog panes intentionally keep the fallback Panels menu.
    async function openFallbackPanels(scope: {
      container: ParentNode;
      click: (element: HTMLElement) => Promise<void>;
    }) {
      const menu = scope.container.querySelector<HTMLElement>(".chat-pane__layout-menu")!;
      const trigger = menu.querySelector<HTMLButtonElement>(".chat-pane__layout-trigger")!;
      if (trigger.getAttribute("aria-expanded") !== "true") {
        await scope.click(trigger);
      }
      await expect
        .poll(() => menu.querySelector<HTMLElement>(".oc-menu")?.dataset.phase)
        .toBe("open");
      return menu;
    }

    async function selectFallbackPanelAction(
      scope: { container: ParentNode; click: (element: HTMLElement) => Promise<void> },
      name: string,
    ) {
      const menu = await openFallbackPanels(scope);
      const action = [...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")].find(
        (item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === name,
      );
      expect(action).toBeDefined();
      await scope.click(action!);
      await expect
        .poll(() => menu.querySelector<HTMLElement>(".oc-menu")?.dataset.phase)
        .toBe("hidden");
    }

    it.each([
      [390, 844],
      [768, 1024],
      [1366, 768],
      [1440, 900],
    ])("keeps the agent identity and keyboard context usable at %sx%s", async (width, height) => {
      const { userEvent } = await import("vitest/browser");
      await page.viewport(width, height);
      const { container, props } = mountChatPaneHeader(containers, {
        mergedChrome: width <= 768,
        narrow: width <= 768,
        agent: {
          id: "research",
          name: "Research lead for international policy and technology",
          textAvatar: "🔬",
        },
        sessionMenuAction: chatPaneHeaderSessionMenu(),
      });
      const header = container.querySelector<HTMLElement>(".chat-pane__header")!;
      const trigger = container.querySelector<HTMLButtonElement>(
        ".chat-pane__agent-identity > button",
      )!;
      const name = container.querySelector<HTMLElement>(".chat-pane__agent-name")!;
      const actions = container.querySelector<HTMLElement>(".chat-pane__header-trailing")!;
      const settings = container.querySelector<HTMLButtonElement>(".chat-pane__agent-settings")!;
      expect(trigger.checkVisibility()).toBe(true);
      expect(name.getBoundingClientRect().width).toBeGreaterThan(40);
      const headerCenter = header.getBoundingClientRect().left + header.clientWidth / 2;
      const identity = container.querySelector<HTMLElement>(".chat-pane__header-agent")!;
      const identityCenter = identity.getBoundingClientRect().left + identity.clientWidth / 2;
      expect(Math.abs(identityCenter - headerCenter)).toBeLessThanOrEqual(2);
      expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(
        actions.getBoundingClientRect().left,
      );
      expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
      // Idle pill is only avatar and name; settings is collapsed inside it and
      // has no title tooltip.
      const pill = container.querySelector<HTMLElement>(".chat-pane__agent-identity")!;
      expect(trigger.querySelector(":scope > svg")).toBeNull();
      expect(settings.hasAttribute("title")).toBe(false);
      expect(getComputedStyle(settings).opacity).toBe("0");
      expect(settings.getBoundingClientRect().width).toBe(0);
      const idlePill = pill.getBoundingClientRect();
      const idleTriggerLeft = trigger.getBoundingClientRect().left;
      const idleBackground = getComputedStyle(settings).backgroundColor;
      await userEvent.hover(trigger);
      // Hover widens the pill rightward to hold settings; the avatar stays put.
      const hoverPill = pill.getBoundingClientRect();
      const hoverSettings = settings.getBoundingClientRect();
      expect(getComputedStyle(settings).opacity).toBe("1");
      expect(getComputedStyle(settings).backgroundColor).toBe(idleBackground);
      expect(hoverPill.width).toBeGreaterThan(idlePill.width + 10);
      expect(hoverPill.left).toBeCloseTo(idlePill.left, 0);
      expect(trigger.getBoundingClientRect().left).toBeCloseTo(idleTriggerLeft, 0);
      expect(hoverSettings.width).toBe(28);
      expect(hoverSettings.left).toBeGreaterThanOrEqual(
        trigger.getBoundingClientRect().right - 0.5,
      );
      expect(hoverSettings.right).toBeLessThanOrEqual(hoverPill.right);
      expect(hoverPill.right).toBeLessThanOrEqual(actions.getBoundingClientRect().left);
      trigger.focus();
      await userEvent.keyboard("{Enter}");
      const context = container.querySelector<HTMLElement>(".chat-pane__agent-context")!;
      await expect.poll(() => context.matches(":popover-open")).toBe(true);
      expect(context.textContent).toContain("Session title");
      expect(context.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
      expect(context.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => context.matches(":popover-open")).toBe(false);
      expect(document.activeElement).toBe(trigger);
      settings.click();
      expect(props.onOpenAgentSettings).toHaveBeenCalledWith("research");
    });

    it.each([
      ["window controls on the left", "--chat-pane-header-inset-start", "paddingLeft", "90px"],
      ["caption buttons on the right", "--chat-pane-header-inset-end", "paddingRight", "146px"],
    ] as const)("centers the agent on the pane with %s", async (_label, inset, side, value) => {
      await page.viewport(1440, 900);
      const { container } = mountChatPaneHeader(containers, {
        agent: { id: "research", name: "Research lead", textAvatar: "🔬" },
      });
      const header = container.querySelector<HTMLElement>(".chat-pane__header")!;
      // Mirrors the shell's window-chrome inset rules, which set both values.
      header.style.setProperty(inset, value);
      header.style[side] = value;
      const headerRect = header.getBoundingClientRect();
      const trigger = container
        .querySelector<HTMLElement>(".chat-pane__agent-identity")!
        .getBoundingClientRect();
      const actions = container
        .querySelector<HTMLElement>(".chat-pane__header-trailing")!
        .getBoundingClientRect();
      expect(
        Math.abs(trigger.left + trigger.width / 2 - (headerRect.left + headerRect.width / 2)),
      ).toBeLessThanOrEqual(1);
      expect(trigger.right).toBeLessThanOrEqual(actions.left);
      expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
    });

    it("keeps the project icon click inside its own target in a narrow desktop pane", async () => {
      const { userEvent } = await import("vitest/browser");
      await page.viewport(1100, 900);
      const { container, props } = mountChatPaneHeader(containers, {
        title: "Prepare the autumn release",
        workspaceLabel: "workspace",
        sharingControl: chatPaneHeaderSharing(),
        sessionMenuAction: chatPaneHeaderSessionMenu(),
        detailsControl: {
          chat: undefined,
          elements: undefined,
          mobile: false,
          presentation: true,
          setRef: () => {},
        },
        onToggleSidePanel: vi.fn(),
      });
      container.style.cssText = "position: fixed; top: 80px; left: 310px; width: 312px";
      const header = container.querySelector<HTMLElement>(".chat-pane__header")!;
      await expect.element(page.elementLocator(header)).toBeVisible();
      const project = [
        ...container.querySelectorAll<HTMLButtonElement>(".chat-pane__workspace-chip"),
      ].find((button) => button.checkVisibility())!;
      const icon = project.querySelector<SVGElement>("svg")!;
      const title = [
        ...container.querySelectorAll<HTMLElement>(".chat-pane__session-title-text"),
      ].find((element) => element.checkVisibility())!;
      for (const width of [312, 644]) {
        container.style.width = `${width}px`;
        const iconBounds = icon.getBoundingClientRect();
        const projectBounds = project.getBoundingClientRect();
        expect(projectBounds.left).toBeLessThanOrEqual(iconBounds.left);
        expect(projectBounds.right).toBeGreaterThanOrEqual(iconBounds.right);
        await page.elementLocator(project).click({
          position: {
            x: iconBounds.right - projectBounds.left - 1,
            y: iconBounds.top - projectBounds.top + iconBounds.height / 2,
          },
        });
        expect(props.onBeginRename).not.toHaveBeenCalled();
        await expect
          .element(page.getByRole("menuitem", { name: "Copy path", exact: true }))
          .toBeVisible();
        expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
        if (width === 312) {
          expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
          expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
          expect(getComputedStyle(title).overflow).toBe("hidden");
        }
        await userEvent.keyboard("{Escape}");
      }
    });

    it("expands and docks through the native desktop frame controls", async () => {
      const setDock = vi.fn();
      const togglePanelExpanded = vi.fn();
      const mounted = mountSolid(() => (
        <DesktopFrameControls
          layout={openSlot({ columns: [] }, "subagents")}
          panelDefinitions={sidebarPanelDefinitions()}
          callbacks={{
            activatePanel: vi.fn(),
            togglePanelExpanded,
            setDock,
            closeSlot: vi.fn(),
            openSlot: vi.fn(),
            reorderPanel: vi.fn(),
            resizePanel: vi.fn(),
            setOpen: vi.fn(),
          }}
          onCloseAll={() => Promise.resolve()}
          closing={false}
          closable={false}
          hasConversation={false}
        />
      ));
      await page
        .elementLocator(mounted.container)
        .getByRole("button", { name: "Expand Side panel", exact: true })
        .click();
      expect(togglePanelExpanded).toHaveBeenCalledOnce();
      await page
        .elementLocator(mounted.container)
        .getByRole("button", { name: "Panel position", exact: true })
        .click();
      await page.getByRole("menuitemradio", { name: "Below", exact: true }).click();
      expect(setDock).toHaveBeenCalledExactlyOnceWith("bottom");
    });

    it.each(["ltr", "rtl"])(
      "keeps compact fallback panel choices anchored and scrollable in %s",
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
            ...sidebarPanelDefinitions()
              .filter((definition) =>
                [
                  "browser",
                  "workspace",
                  "companion",
                  "desktop",
                  "subagents",
                  "processes",
                  "discussion",
                ].includes(definition.slot),
              )
              .map((definition) => ({
                id: definition.slot,
                label: definition.label,
                icon: definition.icon,
                onActivate: vi.fn(),
              })),
          ],
          onOpenSplitView: vi.fn(),
        });
        const scope = {
          container,
          click: (element: HTMLElement) => page.elementLocator(element).click(),
        };
        const menu = await openFallbackPanels(scope);
        const trigger = menu.querySelector<HTMLButtonElement>(".chat-pane__layout-trigger")!;
        expect(trigger.getAttribute("aria-label")).toBe(t("chat.sessionHeader.panels"));
        expect(trigger.textContent?.trim()).toBe("");
        expect(
          [...menu.querySelectorAll("[role^=menuitem]")].map((item) =>
            item.getAttribute("data-value"),
          ),
        ).toEqual([
          "terminal",
          "subagents",
          "processes",
          "browser",
          "workspace",
          "companion",
          "desktop",
          "discussion",
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
        await selectFallbackPanelAction(scope, "Terminal");
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

    it("closes the compact fallback before changing its contents and restores focus on selection and Escape", async () => {
      const observations: Array<{ open: boolean; focused: boolean }> = [];
      const fixture: ReturnType<typeof mountChatPaneHeader> = mountChatPaneHeader(containers, {
        mergedChrome: true,
        narrow: true,
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
      await openFallbackPanels({
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
      await openFallbackPanels({
        container: fixture.container,
        click: (element: HTMLElement) => page.elementLocator(element).click(),
      });
      expect(surface.dataset.phase).toBe("open");
      for (const label of ["Minimize side panel", "Side panel"]) {
        await selectFallbackPanelAction(
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
      "keeps a running batch and fallback controls inside a %ipx compact header",
      async (width) => {
        await page.viewport(width, 800);
        const onTerminal = vi.fn();
        const { container } = mountChatPaneHeader(containers, {
          mergedChrome: true,
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
          detailsControl: {
            chat: undefined,
            mobile: false,
            presentation: true,
            elements: {},
            setRef: () => {},
          },
          sidebarLayout: { columns: [] },
          onLayoutChange: vi.fn(),
          onToggleSidePanel: vi.fn(),
          sharingControl: chatPaneHeaderSharing(),
          sessionMenuAction: chatPaneHeaderSessionMenu(),
        });
        container.style.width = `${width}px`;
        const header = container.querySelector<HTMLElement>(".chat-pane__header")!;
        flush();
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
          expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
          expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
        }
        expect(container.querySelector(".chat-pane__subagents-running")?.textContent).toContain(
          "Subagents · 12 running",
        );
        const scope = {
          container,
          click: (element: HTMLElement) => page.elementLocator(element).click(),
        };
        const menu = await openFallbackPanels(scope);
        const shortcut = menu.querySelector<HTMLElement>("kbd")!;
        expect(shortcut.checkVisibility()).toBe(false);
        const surface = menu.querySelector<HTMLElement>("[role=menu]")!;
        expect(surface.getBoundingClientRect().width).toBeLessThanOrEqual(264);
        await selectFallbackPanelAction(scope, "Toggle terminal");
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
        await waitForSolid(() =>
          expect(
            container.querySelector(
              editor ? ".sidebar-file-view__action" : ".chat-pane__branches-trigger",
            ),
          ).not.toBeNull(),
        );
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
          const layout = container.querySelector<HTMLButtonElement>(
            ".chat-header-session-menu__trigger",
          )!;
          for (const width of [320, 693]) {
            container.style.width = `${width}px`;
            expect(trigger.checkVisibility()).toBe(true);
            const bounds = header.getBoundingClientRect();
            const branchBounds = trigger.getBoundingClientRect();
            const closeBounds = layout.getBoundingClientRect();
            expect(branchBounds.left).toBeGreaterThanOrEqual(bounds.left);
            expect(closeBounds.right).toBeLessThanOrEqual(branchBounds.left);
            expect(branchBounds.right).toBeLessThanOrEqual(bounds.right);
            expect(closeBounds.right).toBeLessThanOrEqual(bounds.right);
            expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
            vi.mocked(props.onBranchSelect).mockClear();
            await page.elementLocator(trigger).click();
            await page.getByRole("menuitem", { name: /Earlier idea/ }).click();
            expect(props.onBranchSelect).toHaveBeenCalledExactlyOnceWith("other");
          }
          await page.elementLocator(layout).click();
          await page.getByRole("menuitem", { name: "View", exact: true }).click();
          await page.getByRole("menuitem", { name: "Close pane", exact: true }).click();
          expect(props.onClosePane).toHaveBeenCalledExactlyOnceWith("pane-1");
        }
      },
    );
  },
);

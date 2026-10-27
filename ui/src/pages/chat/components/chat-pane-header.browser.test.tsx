import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { installTitleTooltips } from "../../../components/tooltip-title.ts";
import { i18n, t } from "../../../i18n/index.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../../lib/keyboard-shortcut-contract.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSidebarRegionCallbackMocks } from "../../../test-helpers/sidebar-region-callbacks.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
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

    it.each(["dark", "light"])("keeps public sharing neutral in the %s theme", async (theme) => {
      const root = document.documentElement;
      const previousMode = root.getAttribute("data-theme-mode");
      root.setAttribute("data-theme-mode", theme);
      onTestFinished(() => {
        if (previousMode === null) {
          root.removeAttribute("data-theme-mode");
        } else {
          root.setAttribute("data-theme-mode", previousMode);
        }
      });
      const { container } = mountChatPaneHeader(containers, {
        sharingControl: chatPaneHeaderSharing({
          state: {
            loading: false,
            result: {
              sessionKey: "agent:main:test",
              members: [],
              identities: [],
              permissions: [],
              role: "owner",
              allowedVisibilities: ["shared"],
              publicShare: { token: `v1.${"a".repeat(96)}`, createdAt: 1 },
            },
          },
        }),
      });
      const trigger = container.querySelector<HTMLElement>(".chat-pane__sharing-trigger")!;
      const state = trigger.querySelector<HTMLElement>(".chat-pane__sharing-trigger-state")!;
      expect(state.textContent).toBe("Public");
      expect(getComputedStyle(state).color).toBe(getComputedStyle(trigger).color);
      const icons = trigger.querySelectorAll("svg");
      expect(icons).toHaveLength(2);
      expect(getComputedStyle(icons[0]!).color).toBe(getComputedStyle(icons[1]!).color);
    });

    it.each([false, true])(
      "reserves the trailing header region before actions arrive (agent=%s)",
      async (agent) => {
        const { container, update } = mountChatPaneHeader(containers, {
          agent: agent ? { id: "research", name: "Research", textAvatar: "🔬" } : undefined,
          onToggleSidePanel: vi.fn(),
        });
        const trailing = container.querySelector<HTMLElement>(".chat-pane__header-trailing")!;
        const actions = container.querySelector<HTMLElement>(".chat-pane__actions")!;
        const actionsBefore = actions.getBoundingClientRect();
        const panels = container.querySelector<HTMLElement>(".chat-pane__panels-toggle")!;
        const before = trailing.getBoundingClientRect();
        const panelsBefore = panels.getBoundingClientRect();
        update({ runAction: { onAbort: vi.fn() } });
        await waitForSolid(() =>
          expect(container.querySelector(".chat-subagent-detail__stop")).not.toBeNull(),
        );
        const after = trailing.getBoundingClientRect();
        expect(after.left).toBeCloseTo(before.left, 1);
        expect(after.width).toBeCloseTo(before.width, 1);
        expect(actions.getBoundingClientRect().left).toBeCloseTo(actionsBefore.left, 1);
        expect(actions.getBoundingClientRect().width).toBeCloseTo(actionsBefore.width, 1);
        expect(panels.getBoundingClientRect().right).toBeCloseTo(panelsBefore.right, 1);
      },
    );

    function findElement(root: ParentNode, selector: string) {
      return root.querySelector<HTMLElement>(selector)!;
    }

    const click = (target: HTMLElement) => page.elementLocator(target).click();

    // Compact and catalog panes intentionally keep the fallback Panels menu.
    async function openFallbackPanels(container: ParentNode) {
      const menu = findElement(container, ".chat-pane__layout-menu");
      const trigger = findElement(menu, ".chat-pane__layout-trigger");
      if (trigger.getAttribute("aria-expanded") !== "true") {
        await click(trigger);
      }
      await expect
        .poll(() => menu.querySelector<HTMLElement>(".oc-menu")?.dataset.phase)
        .toBe("open");
      return menu;
    }

    async function selectFallbackPanelAction(container: ParentNode, name: string) {
      const menu = await openFallbackPanels(container);
      const action = [...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")].find(
        (item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === name,
      );
      expect(action).toBeDefined();
      await click(action!);
      await expect
        .poll(() => menu.querySelector<HTMLElement>(".oc-menu")?.dataset.phase)
        .toBe("hidden");
    }

    it.each([
      [390, 844, null, ""],
      [1366, 768, null, ""],
      [1440, 900, "start", "90px"],
      [1440, 900, "end", "146px"],
    ] as const)(
      "keeps agent identity and keyboard context usable at %sx%s with %s inset",
      async (width, height, inset, value) => {
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
        const header = findElement(container, ".chat-pane__header");
        if (inset) {
          header.style.setProperty(`--chat-pane-header-inset-${inset}`, value);
          header.style[inset === "start" ? "paddingLeft" : "paddingRight"] = value;
        }
        const trigger = findElement(container, ".chat-pane__agent-identity");
        const name = findElement(container, ".chat-pane__agent-name");
        const actions = findElement(container, ".chat-pane__header-trailing");
        const settings = findElement(container, ".chat-pane__agent-settings");
        expect(trigger.checkVisibility()).toBe(true);
        expect(name.getBoundingClientRect().width).toBeGreaterThan(40);
        const headerCenter = header.getBoundingClientRect().left + header.clientWidth / 2;
        const identity = findElement(container, ".chat-pane__header-agent");
        const identityCenter = identity.getBoundingClientRect().left + identity.clientWidth / 2;
        expect(Math.abs(identityCenter - headerCenter)).toBeLessThanOrEqual(inset ? 1 : 2);
        expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(
          actions.getBoundingClientRect().left,
        );
        expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
        // Idle pill is only avatar and name; the settings glyph is collapsed inside it.
        expect(trigger.getAttribute("aria-label")).toBe(
          t("agentChip.namedSettings", { name: props.agent!.name }),
        );
        expect(trigger.hasAttribute("title")).toBe(false);
        expect(getComputedStyle(settings).opacity).toBe("0");
        expect(settings.getBoundingClientRect().width).toBe(0);
        const idlePill = trigger.getBoundingClientRect();
        const idleBackground = getComputedStyle(settings).backgroundColor;
        await userEvent.hover(trigger);
        // Hover widens the pill rightward to hold settings; the avatar stays put.
        const hoverPill = trigger.getBoundingClientRect();
        const hoverSettings = settings.getBoundingClientRect();
        expect(getComputedStyle(settings).opacity).toBe("1");
        expect(getComputedStyle(settings).backgroundColor).toBe(idleBackground);
        expect(hoverPill.width).toBeGreaterThan(idlePill.width + 10);
        expect(hoverPill.left).toBeCloseTo(idlePill.left, 0);
        expect(hoverSettings.width).toBe(28);
        expect(hoverSettings.left).toBeGreaterThanOrEqual(name.getBoundingClientRect().right - 0.5);
        expect(hoverSettings.right).toBeLessThanOrEqual(hoverPill.right);
        expect(hoverPill.right).toBeLessThanOrEqual(actions.getBoundingClientRect().left);
        trigger.focus();
        await userEvent.keyboard("{Enter}");
        expect(props.onOpenAgentSettings).toHaveBeenCalledExactlyOnceWith("research");
      },
    );

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
      const header = findElement(container, ".chat-pane__header");
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
          callbacks={createSidebarRegionCallbackMocks({ togglePanelExpanded, setDock })}
          onCloseAll={() => Promise.resolve()}
          closing={false}
          closable={false}
          hasConversation={false}
        />
      ));
      const controls = page.elementLocator(mounted.container);
      await controls.getByRole("button", { name: "Expand Side panel", exact: true }).click();
      expect(togglePanelExpanded).toHaveBeenCalledOnce();
      await controls.getByRole("button", { name: "Panel position", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Below", exact: true }).click();
      expect(setDock).toHaveBeenCalledExactlyOnceWith("bottom");
    });

    it("opens the selected editor through its native menu", async () => {
      const onOpenEditor = vi.fn();
      const { container } = mountSolid(() => (
        <ChatSidebarEditorMenu
          absolutePath="/repo/example.ts"
          open={false}
          onOpenChange={() => undefined}
          onOpenEditor={onOpenEditor}
        />
      ));
      await page.elementLocator(container).getByRole("button", { name: "Open in editor" }).click();
      await page.getByRole("menuitem", { name: "VS Code" }).click();
      expect(onOpenEditor).toHaveBeenCalledExactlyOnceWith("vscode");
    });

    it.each(["ltr", "rtl"])(
      "keeps compact controls and scrollable panel choices inside the viewport in %s",
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
              .map(({ slot: id, label, icon }) => ({ id, label, icon, onActivate: vi.fn() })),
          ],
          onOpenSplitView: vi.fn(),
          runningSubagentCount: 12,
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
        container.style.width = "320px";
        const header = findElement(container, ".chat-pane__header");
        await expect.element(page.elementLocator(header)).toBeVisible();
        expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
        const headerBounds = header.getBoundingClientRect();
        for (const selector of [
          ".chat-details-toggle",
          ".chat-pane__sharing-trigger",
          ".chat-pane__layout-trigger",
          ".chat-header-session-menu__trigger",
        ]) {
          const button = container.querySelector<HTMLElement>(selector)!;
          expect(button.checkVisibility()).toBe(true);
          expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
          expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(headerBounds.right);
        }
        expect(container.querySelector(".chat-pane__subagents-running")?.textContent).toContain(
          "Subagents · 12 running",
        );
        container.style.width = "";
        const menu = await openFallbackPanels(container);
        const trigger = findElement(menu, ".chat-pane__layout-trigger");
        expect(trigger.getAttribute("aria-label")).toBe(t("chat.sessionHeader.panels"));
        expect(trigger.textContent?.trim()).toBe("");
        const surface = findElement(menu, ":scope > .oc-menu");
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
        await selectFallbackPanelAction(container, "Terminal");
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
      const trigger = findElement(fixture.container, ".chat-details-toggle");
      await click(trigger);
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
      const trigger = findElement(fixture.container, ".chat-pane__layout-trigger");
      const menu = fixture.container.querySelector(".chat-pane__layout-menu")!;
      const surface = menu.querySelector<HTMLElement>('[role="menu"]')!;
      const shown = vi.fn();
      surface.addEventListener("overlay-after-show", shown, { once: true });
      await openFallbackPanels(fixture.container);
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
      await openFallbackPanels(fixture.container);
      expect(surface.dataset.phase).toBe("open");
      for (const [index, label] of ["Minimize side panel", "Side panel"].entries()) {
        const hidden = new Promise<Event>((resolve) => {
          surface.addEventListener("overlay-after-hide", resolve, { once: true });
        });
        await selectFallbackPanelAction(fixture.container, label);
        expect((await hidden).target).toBe(surface);
        expect(observations).toHaveLength(index + 1);
        expect(surface.matches(":popover-open")).toBe(false);
        expect(document.activeElement).toBe(trigger);
      }
      expect(observations).toEqual(
        Array.from({ length: 2 }, () => ({ open: false, focused: true })),
      );
    });

    it.each(["idle", "busy"] as const)("anchors the %s hint to its menu button", async (state) => {
      const busy = state === "busy";
      const reason = "Branch switch is unavailable while the agent is working.";
      const { container, props } = mountChatPaneHeader(containers, {
        branchSwitchDisabledReason: busy ? reason : null,
        onClosePane: state === "idle" ? vi.fn() : undefined,
        branches: [
          { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
          { leafEntryId: "other", headline: "Earlier idea", messageCount: 2, active: false },
        ],
      });
      container.style.cssText =
        state === "idle"
          ? "position: fixed; top: 80px; left: 80px; width: 1000px"
          : "position: fixed; top: 80px; left: 500px; width: 650px";
      await waitForSolid(() =>
        expect(container.querySelector(".chat-pane__branches-trigger")).not.toBeNull(),
      );
      const trigger = container.querySelector<HTMLButtonElement>(".chat-pane__branches-trigger")!;
      await page.elementLocator(trigger).hover();
      const tooltip = () =>
        [...document.querySelectorAll("openclaw-tooltip")]
          .map((element) => element.shadowRoot?.querySelector<HTMLElement>(".tooltip-surface"))
          .find((element) => element?.matches(":popover-open"));
      await expect.poll(() => tooltip()?.textContent).toContain(busy ? reason : "Versions");
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
        await click(trigger);
        await expect.poll(() => tooltip()).toBeUndefined();
        await page.getByRole("menuitem", { name: /Earlier idea/ }).click();
        expect(props.onBranchSelect).toHaveBeenCalledWith("other");
      }

      if (state === "idle") {
        const header = findElement(container, ".chat-pane__header");
        const layout = findElement(container, ".chat-header-session-menu__trigger");
        const closePane = findElement(container, ".chat-pane__close");
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
          const closePaneBounds = closePane.getBoundingClientRect();
          expect(closePane.checkVisibility()).toBe(true);
          expect(closePaneBounds.width).toBe(32);
          expect(closePaneBounds.height).toBe(32);
          expect(closePaneBounds.left).toBeGreaterThanOrEqual(branchBounds.right);
          expect(closePaneBounds.right).toBeLessThanOrEqual(bounds.right);
          vi.mocked(props.onBranchSelect).mockClear();
          await click(trigger);
          await page.getByRole("menuitem", { name: /Earlier idea/ }).click();
          expect(props.onBranchSelect).toHaveBeenCalledExactlyOnceWith("other");
        }
        await click(closePane);
        expect(props.onClosePane).toHaveBeenCalledExactlyOnceWith("pane-1");
      }
    });
  },
);

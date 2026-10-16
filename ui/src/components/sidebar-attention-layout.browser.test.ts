import { render as renderSolid, type JSX } from "@solidjs/web";
import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../app/context.ts";
import { client, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  buildSidebarInboxEntries,
  type SidebarAttentionItem,
  type SidebarInboxEntry,
} from "./sidebar-attention-entries.ts";
import "../test-helpers/load-styles.ts";
import "../styles/hub-tabs.css";
import "../styles/sidebar-attention-floating.css";
import "../styles/sidebar-issues.css";
import {
  SidebarAttentionPanel,
  type SidebarAttentionPanelParams,
} from "./sidebar-attention-panel.runtime.tsx";
// Upgrade the real element: the floating layout once regressed because a base
// class stamped inline `display: contents`, which only a live upgrade reveals.
import "./sidebar-attention.tsx";
import { inboxMention } from "./sidebar-inbox.test-support.ts";
import { HubTabs, type HubTabsProps } from "./solid/hub-tabs.tsx";
import layoutCss from "../styles/layout.css?inline";
import floatingCss from "../styles/sidebar-attention-floating.css?inline";

function part<T extends HTMLElement = HTMLElement>(root: ParentNode, name: string) {
  return root.querySelector<T>(`.sidebar-issues-panel__${name}`)!;
}
const bounds = (element: Element | Range) => element.getBoundingClientRect();
const style = (element: Element) => getComputedStyle(element);
const mountedPanels = new Map<Element, () => void>();
function render(view: () => JSX.Element, container: Element) {
  mountedPanels.get(container)?.();
  mountedPanels.set(container, renderSolid(view, container));
  flush();
}

const authWarning: SidebarAttentionItem = {
  type: "attention",
  category: "system",
  dismissal: { kind: "modelAuthExpired", signature: "expired-profile" },
  requiresAction: true,
  severity: "warning",
  kind: "modelAuthExpired",
  icon: "plug",
  label: "Auth expired",
  detail: "Reconnect the provider.",
  action: { kind: "navigate", routeId: "config" },
  signature: "expired-profile",
};

function panel(params: SidebarAttentionPanelParams) {
  return () => createComponent(SidebarAttentionPanel, params);
}
function inboxEntries(attention: SidebarAttentionItem[], mentions: MentionInboxItem[]) {
  return buildSidebarInboxEntries({
    approvals: [],
    attention,
    mentions,
    scopeUpgrade: null,
    update: null,
  });
}
function mountPanel(params: SidebarAttentionPanelParams) {
  const shell = document.body.appendChild(document.createElement("div"));
  render(panel(params), shell);
  return shell;
}
function panelParams(entries: readonly SidebarInboxEntry[]): SidebarAttentionPanelParams {
  return {
    context: {
      basePath: "",
      navigate: vi.fn(),
      gateway: createGatewayHarness(client(vi.fn(async () => ({})))).gateway,
    } as unknown as ApplicationContext,
    mentions: {
      snapshot: {
        phase: "ready",
        items: entries.flatMap((entry) => (entry.type === "mention" ? [entry.mention] : [])),
        dismissing: [],
        error: null,
      },
      refresh: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn().mockResolvedValue(undefined),
      subscribe: () => () => undefined,
      dispose: () => undefined,
    },
    entries,
    onApprovalDecision: () => {},
    onClose: () => {},
    onDismiss: vi.fn(),
    onKeydown: () => {},
    onNavigate: () => {},
    onOpen: () => {},
    onScroll: () => {},
    onSelectTab: () => {},
    overflowAbove: false,
    overflowBelow: false,
    panelPosition: { left: 0, anchor: "top", top: 0 },
    selectedTab: "all",
  };
}

afterEach(() => {
  for (const dispose of mountedPanels.values()) {
    dispose();
  }
  mountedPanels.clear();
  document.body.replaceChildren();
  document.documentElement.classList.remove(
    "openclaw-native-nav",
    "openclaw-native-macos",
    "openclaw-native-web-chrome",
  );
});

describe.runIf("__vitest_browser__" in globalThis)("Inbox panel layout", () => {
  it("keeps the header and tabs fixed when the selected category is empty", async () => {
    const params = panelParams([authWarning]);

    for (const mobile of [false, true]) {
      const shell = document.createElement("div");
      shell.className = mobile ? "shell shell--mobile-nav" : "shell";
      document.body.append(shell);
      const [selectedTab, setSelectedTab] = createSignal<"all" | "approvals">("all");
      render(
        panel({
          ...params,
          get selectedTab() {
            return selectedTab();
          },
        }),
        shell,
      );
      await waitForSolid(() => expect(part(shell, "tabs")).not.toBeNull());
      await shell.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
        "openclaw-tooltip",
      )?.updateComplete;
      const populatedHeader = part(shell, "header");
      const populatedTabs = part(shell, "tabs");
      const headerHeight = bounds(populatedHeader).height;
      const tabsTop = bounds(populatedTabs).top;

      setSelectedTab("approvals");
      flush();
      const placeholder = part<HTMLButtonElement>(shell, "dismiss-shown");
      expect(placeholder.disabled).toBe(true);
      expect(placeholder.getAttribute("aria-hidden")).toBe("true");
      expect(style(placeholder).visibility).toBe("hidden");
      expect(part(shell, "header").getBoundingClientRect().height).toBe(headerHeight);
      expect(part(shell, "tabs").getBoundingClientRect().top).toBe(tabsTop);
      shell.remove();
    }
  });

  it.each(["system", "mentions", "all"] as const)(
    "dismisses only the selected %s tab without mixing mentions and local snoozes",
    (selectedTab) => {
      const entries = inboxEntries(
        [authWarning],
        [inboxMention("mention-a"), inboxMention("mention-b")],
      );
      const params = panelParams(entries);
      params.mentions.snapshot.dismissing = ["mention-b"];
      const shell = mountPanel({ ...params, selectedTab });

      expect(
        Array.from(shell.querySelectorAll("[data-mention-id]"), (row) =>
          row.getAttribute("data-mention-id"),
        ),
      ).toEqual(selectedTab === "system" ? [] : ["mention-a", "mention-b"]);
      part<HTMLButtonElement>(shell, "dismiss-shown").click();

      if (selectedTab === "system") {
        expect(params.mentions.dismiss).not.toHaveBeenCalled();
      } else {
        expect(params.mentions.dismiss).toHaveBeenCalledExactlyOnceWith(["mention-a"]);
      }
      if (selectedTab === "mentions") {
        expect(params.onDismiss).not.toHaveBeenCalled();
      } else {
        expect(params.onDismiss).toHaveBeenCalledExactlyOnceWith(authWarning.dismissal);
      }
    },
  );

  it("keeps existing mentions visible with a refresh action after a request fails", () => {
    const entries = inboxEntries([], [inboxMention("mention-a")]);
    const params = panelParams(entries);
    params.mentions.snapshot.phase = "error";
    params.mentions.snapshot.error = "Connection interrupted";
    const shell = mountPanel({ ...params, selectedTab: "mentions" });

    expect(shell.querySelector('[data-mention-id="mention-a"]')).not.toBeNull();
    expect(part(shell, "empty")).toBeNull();
    const error = shell.querySelector('.sidebar-issues-panel__mentions-note[role="status"]')!;
    expect(error.textContent).toContain("Connection interrupted");
    const refresh = error.querySelector<HTMLButtonElement>("button")!;
    expect(refresh.textContent?.trim()).toBe("Refresh mentions");
    refresh.click();
    expect(params.mentions.refresh).toHaveBeenCalledOnce();
  });

  it.each(["base-first", "base-last"])(
    "positions collapsed sidebar attention beyond chrome controls (%s)",
    async (order) => {
      // Entry CSS and the lazy component may arrive in either order. Use both
      // complete owners so this also catches resets introduced in the base sheet.
      const sheets = (
        order === "base-first" ? [layoutCss, floatingCss] : [floatingCss, layoutCss]
      ).map((css) => {
        const sheet = document.createElement("style");
        sheet.textContent = css;
        document.head.append(sheet);
        return sheet;
      });
      onTestFinished(() => sheets.forEach((sheet) => sheet.remove()));
      const shell = document.createElement("div");
      shell.className = "shell shell--nav-collapsed shell--home-control shell--floating-attention";
      shell.innerHTML = `
      <div class="shell-chrome-controls">
        <button class="shell-chrome-controls__button"></button>
        <button class="shell-chrome-controls__button"></button>
        <button class="shell-chrome-controls__button"></button>
        <button class="shell-chrome-controls__button shell-chrome-controls__home"></button>
      </div>
      <nav class="macos-titlebar-controls">
        ${Array.from(
          { length: 2 },
          () => '<button class="topbar-icon-btn macos-titlebar-controls__button"></button>',
        ).join("")}
      </nav>
      <main class="content">
        <openclaw-sidebar-attention class="sidebar-attention--floating"></openclaw-sidebar-attention>
      </main>
    `;
      const provider = createApplicationContextProvider(panelParams([]).context);
      provider.append(shell);
      document.body.append(provider);

      const attention = shell.querySelector<HTMLElement>("openclaw-sidebar-attention")!;
      const chrome = shell.querySelector<HTMLElement>(".shell-chrome-controls")!;
      const nativeChrome = shell.querySelector<HTMLElement>(".macos-titlebar-controls")!;
      // The real shell mounts this row only in native web-chrome mode.
      nativeChrome.remove();
      await waitForSolid(() =>
        expect(attention.querySelector(".sidebar-issues-button")).not.toBeNull(),
      );
      const inbox = attention.querySelector<HTMLElement>(".sidebar-issues-button")!;

      expect(style(attention)).toMatchObject({ position: "fixed", display: "flex" });
      expect(bounds(attention).left).toBeGreaterThanOrEqual(bounds(chrome).right + 8);
      const paint = () => ({
        border: style(inbox).borderTopWidth,
        background: style(inbox).backgroundColor,
      });
      expect(Number.parseFloat(paint().border)).toBeGreaterThan(0);
      const resting = paint();
      expect(resting.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(style(inbox).boxShadow).not.toBe("none");
      expect(style(inbox).backdropFilter).toBe("blur(10px)");
      const { page } = await import("vitest/browser");
      await page.elementLocator(inbox).hover();
      const hovered = paint();
      expect(hovered.border).toBe(resting.border);
      expect(hovered.background).not.toBe(resting.background);
      await page.elementLocator(chrome.querySelector("button")!).hover();
      inbox.setAttribute("aria-expanded", "true");
      expect(paint()).toEqual(hovered);
      inbox.setAttribute("aria-expanded", "false");
      expect(paint()).toEqual(resting);

      document.documentElement.classList.add("openclaw-native-nav");
      expect(bounds(attention).left).toBeGreaterThanOrEqual(8);

      document.documentElement.classList.add("openclaw-native-macos");
      expect(style(attention).top).toBe("52px");

      shell.append(nativeChrome);
      document.documentElement.classList.add("openclaw-native-web-chrome");
      expect(bounds(attention).left).toBe(bounds(chrome).right + 8);
      expect(bounds(nativeChrome).left).toBeGreaterThanOrEqual(bounds(attention).right + 8);
      expect(paint()).toEqual({ border: "0px", background: "rgba(0, 0, 0, 0)" });
      expect(style(inbox).boxShadow).toBe("none");
      expect(style(inbox).backdropFilter).toBe("none");
      attention.classList.remove("sidebar-attention--floating");
      shell.classList.remove("shell--floating-attention");
      expect(paint()).toEqual({ border: "0px", background: "rgba(0, 0, 0, 0)" });
      expect(style(inbox).boxShadow).toBe("none");
      expect(style(inbox).backdropFilter).toBe("none");
    },
  );

  it.each([
    { mobile: false, width: 390, textScale: 1 },
    { mobile: true, width: 390, textScale: 1 },
    { mobile: true, width: 320, textScale: 1 },
    { mobile: true, width: 320, textScale: 1.5 },
  ])(
    "keeps Inbox tabs readable and reachable ($width px, $textScale scale, mobile: $mobile)",
    async ({ mobile, width, textScale }) => {
      const { userEvent } = await import("vitest/browser");
      const rootStyle = document.documentElement.style;
      const previousTextScale = rootStyle.getPropertyValue("--control-ui-text-scale");
      onTestFinished(() => rootStyle.setProperty("--control-ui-text-scale", previousTextScale));
      rootStyle.setProperty("--control-ui-text-scale", String(textScale));
      const fixture = document.createElement("section");
      fixture.className = "sidebar-issues-panel";
      fixture.style.position = "static";
      fixture.style.width = `${width}px`;
      fixture.style.height = "220px";
      const listWrap = document.createElement("div");
      listWrap.className = "sidebar-issues-panel__list-wrap";
      listWrap.innerHTML = `<div class="sidebar-issues-panel__list">${Array.from(
        { length: 6 },
        (_, index) => `<div data-attention-kind="cronFailed">
          <div class="sidebar-issues-panel__summary">Inbox item ${index}</div>
        </div>`,
      ).join("")}</div>`;
      render(
        () => [
          createComponent(HubTabs, {
            id: "inbox-fixture",
            active: "tab-0",
            ariaLabel: "Inbox categories",
            panelId: "inbox-fixture-panel",
            class: "sidebar-issues-panel__tabs",
            variant: "sub",
            tabs: ["All", "Approvals", "Mentions", "Automations", "System"].map((label, index) => ({
              value: `tab-${index}`,
              label,
              count: index || undefined,
            })),
            onSelect: () => undefined,
          } satisfies HubTabsProps<string>),
          listWrap,
        ],
        fixture,
      );
      const shell = document.createElement("div");
      shell.className = mobile ? "shell shell--mobile-nav" : "shell";
      shell.append(fixture);
      document.body.append(shell);

      await waitForSolid(() => expect(fixture.querySelector('[role="tab"]')).not.toBeNull());
      const group = part(fixture, "tabs");
      const header = document.createElement("header");
      header.className = "sidebar-issues-panel__header";
      fixture.prepend(header);
      const tabs = Array.from(fixture.querySelectorAll<HTMLElement>(".hub-tab"));
      const badgeTab = tabs[1];
      expect(group).not.toBeNull();
      expect(badgeTab).not.toBeNull();
      expect(group!.querySelector("[active]")?.getAttribute("data-tab-value")).toBe("tab-0");

      const badge = badgeTab!.querySelector<HTMLElement>(".hub-tab__badge");
      const list = part(fixture, "list");
      const item = fixture.querySelector<HTMLElement>("[data-attention-kind]");
      const summary = part(fixture, "summary");

      expect(bounds(group!).width).toBeLessThanOrEqual(fixture.clientWidth);
      expect(style(group!).overflowX).toBe("auto");
      expect(style(group!).backgroundColor).toBe(style(header).backgroundColor);
      expect(style(group!).backgroundColor).not.toBe(style(list!).backgroundColor);
      // The track hairline is the header/list separator; it must span the panel.
      const colorProbe = document.createElement("span");
      colorProbe.style.cssText = "position: absolute; color: var(--track-color);";
      group.append(colorProbe);
      const separatorColor = style(colorProbe).color;
      colorProbe.remove();
      const paint = document.createElement("canvas").getContext("2d")!;
      paint.fillStyle = separatorColor;
      paint.fillRect(0, 0, 1, 1);
      expect(paint.getImageData(0, 0, 1, 1).data[3]).toBeGreaterThan(0);
      expect(style(group).boxShadow).toBe(`${separatorColor} 0px -2px 0px 0px inset`);
      expect(style(group).paddingBottom).toBe("2px");
      if (width === 320) {
        expect(group.scrollWidth).toBeGreaterThan(group.clientWidth);
      }
      for (const [index, tab] of tabs.entries()) {
        const label = Array.from(tab.childNodes).find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        )!;
        const range = document.createRange();
        range.selectNodeContents(label);
        const labelBounds = bounds(range);
        const tabBounds = bounds(tab);
        if (index > 0) {
          expect(tabBounds.left).toBeGreaterThanOrEqual(
            tabs[index - 1]!.getBoundingClientRect().right - 1,
          );
        }
        expect(labelBounds.width).toBeGreaterThan(0);
        expect(labelBounds.left).toBeGreaterThanOrEqual(tabBounds.left - 1);
        expect(labelBounds.right).toBeLessThanOrEqual(tabBounds.right + 1);
        const tabBadge = tab.querySelector<HTMLElement>(".hub-tab__badge");
        if (tabBadge) {
          const badgeBounds = bounds(tabBadge);
          expect(badgeBounds.left).toBeGreaterThanOrEqual(labelBounds.right - 1);
          expect(badgeBounds.right).toBeLessThanOrEqual(tabBounds.right + 1);
        }
      }
      tabs[0]!.focus();
      for (const [key, tab] of [
        ["End", tabs.at(-1)!],
        ["Home", tabs[0]!],
      ] as const) {
        const openingTransform = style(fixture).transform;
        await userEvent.keyboard(`{${key}}`);
        expect(document.activeElement).toBe(tab);
        await expect
          .poll(
            () => {
              const tabBounds = bounds(tab);
              const viewport = bounds(group);
              return Math.max(viewport.left - tabBounds.left, tabBounds.right - viewport.right);
            },
            {
              message: `${key} keeps the focused tab inside its scrollport during ${openingTransform}`,
            },
          )
          .toBeLessThanOrEqual(1);
      }
      // Count badges render as pills separated from the tab label.
      expect(badge).not.toBeNull();
      expect(style(badge!).borderRadius).not.toBe("0px");
      expect(style(summary!).paddingBlock).toBe("8px");
      expect(bounds(item!).right).toBeCloseTo(bounds(list!).right, 1);
    },
  );

  it("keeps mobile controls touch-sized and the sheet header visually continuous", () => {
    const shell = document.createElement("div");
    shell.className = "shell shell--mobile-nav";
    shell.innerHTML = `
      <section class="sidebar-issues-panel">
        <div class="sidebar-issues-panel__grabber"></div>
        <header class="sidebar-issues-panel__header">
          <div class="sidebar-issues-panel__header-actions">
            <button class="sidebar-issues-panel__dismiss-shown" type="button">Dismiss shown</button>
            <button class="sidebar-brand__icon sidebar-issues-panel__mobile-close" type="button">
              Close
            </button>
          </div>
        </header>
        <div class="sidebar-issues-panel__list-wrap"></div>
        <div class="sidebar-issues-panel__summary">
          <button class="sidebar-issues-panel__dismiss" type="button">Dismiss</button>
        </div>
      </section>
    `;
    document.body.append(shell);

    const dismiss = part(shell, "dismiss");
    const dismissShown = part(shell, "dismiss-shown");
    const close = part(shell, "mobile-close");
    const sheet = shell.querySelector<HTMLElement>(".sidebar-issues-panel")!;
    const header = part(shell, "header");
    const list = part(shell, "list-wrap");
    const dismissStyle = style(dismiss);

    expect(dismissStyle.opacity).toBe("1");
    expect(dismissStyle.pointerEvents).not.toBe("none");
    expect(bounds(dismiss).width).toBeGreaterThanOrEqual(40);
    expect(bounds(dismiss).height).toBeGreaterThanOrEqual(40);
    expect(bounds(dismissShown).height).toBeGreaterThanOrEqual(40);
    expect(bounds(close)).toMatchObject({ width: 36, height: 36 });
    expect(style(close)).toMatchObject({ borderTopWidth: "1px", borderRadius: "9999px" });
    expect(style(close).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(style(sheet).backgroundColor).toBe(style(header).backgroundColor);
    expect(style(header).backgroundColor).not.toBe(style(list).backgroundColor);
  });
});

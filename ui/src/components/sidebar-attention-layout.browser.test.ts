import { render as renderSolid } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../app/context.ts";
import type { MentionsCapability } from "../app/mentions.ts";
import { client, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import { createApplicationOverlays } from "../app/overlays.ts";
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
import layoutCss from "../styles/layout.css?inline";
import floatingCss from "../styles/sidebar-attention-floating.css?inline";

const query = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector)!;
const part = (root: ParentNode, name: string) => query(root, `.sidebar-issues-panel__${name}`);
const bounds = (target: Element | Range) => target.getBoundingClientRect();
const style = (target: Element) => getComputedStyle(target);
function backgroundAlpha(target: Element) {
  const paint = document.createElement("canvas").getContext("2d")!;
  paint.fillStyle = style(target).backgroundColor;
  paint.fillRect(0, 0, 1, 1);
  return paint.getImageData(0, 0, 1, 1).data[3];
}
function horizontalOverflow(inner: Element | Range, outer: Element) {
  const child = bounds(inner);
  const parent = bounds(outer);
  return Math.max(parent.left - child.left, child.right - parent.right);
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = "") {
  return Object.assign(document.createElement(tag), { className, innerHTML: html });
}
function shellFor(mobile = false) {
  return document.body.appendChild(element("div", mobile ? "shell shell--mobile-nav" : "shell"));
}
const mountedPanels = new Map<Element, () => void>();

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

function inboxEntries(attention: SidebarAttentionItem[], mentions: MentionInboxItem[]) {
  return buildSidebarInboxEntries({
    approvals: [],
    attention,
    mentions,
    scopeUpgrade: null,
    update: null,
  });
}
type PanelFixtureParams = SidebarAttentionPanelParams & {
  context: ApplicationContext;
  mentions: MentionsCapability;
};
function mountPanel(
  params: PanelFixtureParams,
  shell = document.body.appendChild(document.createElement("div")),
) {
  mountedPanels.set(
    shell,
    renderSolid(() => SidebarAttentionPanel(params, params.context, params.mentions), shell),
  );
  flush();
  return shell;
}
function panelParams(entries: readonly SidebarInboxEntry[]): PanelFixtureParams {
  const harness = createGatewayHarness(client(vi.fn(async () => ({}))));
  const { gateway } = harness;
  harness.update({
    hello: {
      ...gateway.snapshot.hello!,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["mentions.dismiss"] },
    },
  });
  const overlays = createApplicationOverlays(gateway);
  onTestFinished(() => overlays.dispose());
  return {
    context: {
      basePath: "",
      navigate: vi.fn(),
      gateway,
      overlays,
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
    onSelectTab: () => {},
    overflowAbove: false,
    overflowBelow: false,
    panelPosition: { left: 0, anchor: "top", top: 0 },
    selectedTab: "all",
  };
}

afterEach(() => {
  mountedPanels.forEach((dispose) => dispose());
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
      const shell = shellFor(mobile);
      const [selectedTab, setSelectedTab] = createSignal<"all" | "approvals">("all");
      mountPanel(
        {
          ...params,
          get selectedTab() {
            return selectedTab();
          },
        },
        shell,
      );
      await waitForSolid(() => expect(part(shell, "tabs")).not.toBeNull());
      await shell.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
        "openclaw-tooltip",
      )?.updateComplete;
      const headerHeight = bounds(part(shell, "header")).height;
      const tabsTop = bounds(part(shell, "tabs")).top;

      setSelectedTab("approvals");
      flush();
      const placeholder = shell.querySelector<HTMLButtonElement>(
        ".sidebar-issues-panel__dismiss-shown",
      )!;
      expect(placeholder.disabled).toBe(true);
      expect(placeholder.getAttribute("aria-hidden")).toBe("true");
      expect(style(placeholder).visibility).toBe("hidden");
      expect(bounds(part(shell, "header")).height).toBe(headerHeight);
      expect(bounds(part(shell, "tabs")).top).toBe(tabsTop);
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
      part(shell, "dismiss-shown").click();

      expect(vi.mocked(params.mentions.dismiss).mock.calls).toEqual(
        selectedTab === "system" ? [] : [[["mention-a"]]],
      );
      expect(vi.mocked(params.onDismiss).mock.calls).toEqual(
        selectedTab === "mentions" ? [] : [[authWarning.dismissal]],
      );
    },
  );

  it("keeps existing mentions visible with a refresh action after a request fails", () => {
    const entries = inboxEntries([], [inboxMention("mention-a")]);
    const params = panelParams(entries);
    params.mentions.snapshot.phase = "error";
    params.mentions.snapshot.error = "Connection interrupted";
    const shell = mountPanel({ ...params, selectedTab: "mentions" });

    expect(query(shell, '[data-mention-id="mention-a"]')).not.toBeNull();
    expect(part(shell, "empty")).toBeNull();
    const error = query(shell, '.sidebar-issues-panel__mentions-note[role="status"]');
    expect(error.textContent).toContain("Connection interrupted");
    const refresh = error.querySelector<HTMLButtonElement>("button")!;
    expect(refresh.textContent?.trim()).toBe("Refresh mentions");
    refresh.click();
    expect(params.mentions.refresh).toHaveBeenCalledOnce();
  });

  it.each(["base-first", "base-last"])(
    "positions collapsed sidebar attention beyond chrome controls (%s)",
    async (order) => {
      const sheets = (
        order === "base-first" ? [layoutCss, floatingCss] : [floatingCss, layoutCss]
      ).map((css) => {
        const sheet = element("style", "", css);
        document.head.append(sheet);
        return sheet;
      });
      onTestFinished(() => sheets.forEach((sheet) => sheet.remove()));
      const shell = element(
        "div",
        "shell shell--nav-collapsed shell--home-control shell--floating-attention",
        `<div class="shell-chrome-controls">
        ${'<button class="shell-chrome-controls__button"></button>'.repeat(3)}
        <button class="shell-chrome-controls__button shell-chrome-controls__home"></button></div>
      <nav class="macos-titlebar-controls">
        ${'<button class="topbar-icon-btn macos-titlebar-controls__button"></button>'.repeat(2)}</nav>
      <main class="content">
        <openclaw-sidebar-attention class="sidebar-attention--floating"></openclaw-sidebar-attention></main>`,
      );
      const provider = createApplicationContextProvider(panelParams([]).context);
      provider.append(shell);
      document.body.append(provider);

      const attention = query(shell, "openclaw-sidebar-attention");
      const chrome = query(shell, ".shell-chrome-controls");
      const nativeChrome = query(shell, ".macos-titlebar-controls");
      // The real shell mounts this row only in native web-chrome mode.
      nativeChrome.remove();
      await waitForSolid(() => expect(query(attention, ".sidebar-issues-button")).not.toBeNull());
      const inbox = query(attention, ".sidebar-issues-button");

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
      await page.elementLocator(query(chrome, "button")).hover();
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
      const expectTransparent = () =>
        expect(style(inbox)).toMatchObject({
          borderTopWidth: "0px",
          backgroundColor: "rgba(0, 0, 0, 0)",
          boxShadow: "none",
          backdropFilter: "none",
        });
      expectTransparent();
      attention.classList.remove("sidebar-attention--floating");
      shell.classList.remove("shell--floating-attention");
      expectTransparent();
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
      const shell = shellFor(mobile);
      const entries = inboxEntries([authWarning], [inboxMention("a"), inboxMention("b")]);
      mountPanel(panelParams(entries), shell);
      const fixture = query(shell, ".sidebar-issues-panel");
      Object.assign(fixture.style, { position: "static", width: `${width}px`, height: "220px" });
      await waitForSolid(() => expect(fixture.querySelector('[role="tab"]')).not.toBeNull());
      const group = part(fixture, "tabs");
      const header = part(fixture, "header");
      const tabs = Array.from(fixture.querySelectorAll<HTMLElement>(".hub-tab"));
      expect(group.querySelector("[active]")?.getAttribute("data-tab-value")).toBe("all");
      const badge = query(group, ".hub-tab__badge");
      const list = part(fixture, "list");
      const item = query(fixture, "[data-attention-kind]");
      const summary = part(fixture, "summary");

      expect(bounds(group).width).toBeLessThanOrEqual(fixture.clientWidth);
      expect(style(group)).toMatchObject({
        overflowX: "auto",
        backgroundColor: style(header).backgroundColor,
        paddingBottom: "2px",
      });
      expect(style(group).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(backgroundAlpha(fixture)).toBe(255);
      expect(style(part(fixture, "list-wrap")).backgroundColor).toBe(
        style(fixture).backgroundColor,
      );
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
          expect(tabBounds.left).toBeGreaterThanOrEqual(bounds(tabs[index - 1]!).right - 1);
        }
        expect(labelBounds.width).toBeGreaterThan(0);
        expect(horizontalOverflow(range, tab)).toBeLessThanOrEqual(1);
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
        await userEvent.keyboard(`{${key}}`);
        expect(document.activeElement).toBe(tab);
        await expect.poll(() => horizontalOverflow(tab, group)).toBeLessThanOrEqual(1);
      }
      expect(style(badge).borderRadius).not.toBe("0px");
      expect(style(summary!).paddingBlock).toBe("8px");
      expect(bounds(item!).right).toBeCloseTo(bounds(list!).right, 1);
    },
  );

  it("keeps mobile controls touch-sized and the sheet header visually continuous", () => {
    const shell = shellFor(true);
    mountPanel(panelParams([authWarning]), shell);
    const dismiss = part(shell, "dismiss");
    const dismissShown = part(shell, "dismiss-shown");
    const close = part(shell, "mobile-close");
    const sheet = query(shell, ".sidebar-issues-panel");
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
    expect(style(header).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(backgroundAlpha(sheet)).toBe(255);
    expect(style(list).backgroundColor).toBe(style(sheet).backgroundColor);
  });
});

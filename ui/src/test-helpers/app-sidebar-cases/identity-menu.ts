import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationOverlays } from "../../app/overlays-types.ts";
import {
  dismissSidebarAttention,
  resolveSidebarAttentionKey,
  resolveUpdateAttentionDismissal,
} from "../../components/sidebar-attention-dismissals.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  mountSidebarContext,
} from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { waitForSolid } from "../solid-settle.ts";
import "../../components/app-sidebar.tsx";

async function mountIdentity() {
  const gateway = createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient);
  const { sidebar } = await mountSidebar(
    gateway.gateway,
    createSessions("main", ["agent:main:main"]),
  );
  return { gateway, sidebar, dom: domProbe(sidebar) };
}

function expectAttributes(
  element: Element | null | undefined,
  attributes: Record<string, string | null>,
) {
  for (const [name, value] of Object.entries(attributes)) {
    expect(element?.getAttribute(name), name).toBe(value);
  }
}

function menuItems(menu: HTMLElement | null, enabledOnly = false) {
  const selector = enabledOnly ? '[role="menuitem"][data-value]' : '[role^="menuitem"][data-value]';
  return [...(menu?.querySelectorAll<HTMLElement>(selector) ?? [])].filter(
    (item) =>
      item.closest('[role="menu"]') === menu &&
      !item.closest(".sidebar-identity-menu__footer") &&
      (!enabledOnly || !item.hasAttribute("disabled")),
  );
}

describe("AppSidebar footer identity menu", () => {
  it("opens Profile from the Owner header without a self user", async () => {
    const { sidebar, dom } = await mountIdentity();
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    dom.query<HTMLButtonElement>(".sidebar-identity-card")?.click();
    await sidebar.updateComplete;

    const menu = dom.query<HTMLElement>(".sidebar-identity-menu");
    const view = domProbe(menu!);
    const header = view.query<HTMLElement>('[data-value="command:profile"]');
    expect(header?.querySelector(".sidebar-identity-menu__name")?.textContent?.trim()).toBe(
      "Owner",
    );
    expect(header?.querySelector('[data-viewer-id="owner"]')?.textContent).toContain("O");
    header?.click();
    await sidebar.updateComplete;
    expect(onNavigate).toHaveBeenCalledWith("profile", { hash: "#settings-profile-identity" });
  });

  it("keeps release availability on Updates after dismissing the Inbox notice", async () => {
    const gatewayHarness = createGatewayHarness({
      instanceId: "self-instance",
    } as GatewayBrowserClient);
    gatewayHarness.publish({
      selfUser: { id: "alice", name: "Alice" },
      hello: {
        ...gatewayHarness.gateway.snapshot.hello!,
        server: { ...gatewayHarness.gateway.snapshot.hello!.server, bootId: "boot-a" },
      },
    });
    const context = createContext(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    const subscribers = new Set<Parameters<ApplicationOverlays["subscribe"]>[0]>();
    vi.mocked(context.overlays.subscribe).mockImplementation((notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    });
    const { sidebar } = await mountSidebarContext(context);
    const dom = domProbe(sidebar);
    (context.overlays as unknown as { snapshot: ApplicationOverlays["snapshot"] }).snapshot = {
      ...context.overlays.snapshot,
      updateAvailable: { currentVersion: "2026.8.1", latestVersion: "2026.8.2", channel: "stable" },
      updateSchedule: null,
      updateStatusBanner: null,
    };
    const dismissal = resolveUpdateAttentionDismissal({
      gatewayBootId: "boot-a",
      updateAvailable: context.overlays.snapshot.updateAvailable,
    });
    if (!dismissal) {
      throw new Error("expected update dismissal fact");
    }
    dismissSidebarAttention(resolveSidebarAttentionKey(gatewayHarness.gateway), dismissal);
    dom.query<HTMLButtonElement>(".sidebar-identity-card")?.click();
    await sidebar.updateComplete;
    const updates = () => dom.query<HTMLElement>('[data-value="command:updates"]');
    expect(updates()?.textContent).toContain("Available");
    expect(updates()?.getAttribute("aria-label")).toBe("Updates. Update available");
    expect(dom.query(".sidebar-footer-build__update")).toBeNull();

    (context.overlays as unknown as { snapshot: ApplicationOverlays["snapshot"] }).snapshot = {
      ...context.overlays.snapshot,
      updateAvailable: { currentVersion: "2026.8.2", latestVersion: "2026.8.2", channel: "stable" },
    };
    subscribers.forEach((notify) => notify(context.overlays.snapshot));
    await waitForSolid(() => {
      expect(updates()?.textContent).not.toContain("Available");
      expect(updates()?.getAttribute("aria-label")).toBe("Updates");
    });
  });

  it("owns account utilities, restores focus, and routes Profile", async () => {
    const fullName = "Ada Lovelace With A Deliberately Long Display Name";
    const email = "ada.with.a.deliberately.long.address@example.test";
    const avatarUrl = "/api/users/self/avatar?v=1";
    const { sidebar, gateway, dom } = await mountIdentity();
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.canPairDevice = false;
    sidebar.onNavigate = onNavigate;
    gateway.publish({ selfUser: { id: "self", name: fullName, email, avatarUrl } });
    await sidebar.updateComplete;

    const identity = dom.query<HTMLButtonElement>(".sidebar-identity-card");
    const card = domProbe(identity!);
    expectAttributes(identity, { "aria-haspopup": "menu", "aria-expanded": "false" });
    expect(identity?.getAttribute("aria-label")).toContain(fullName);
    expect(card.query("[title], [data-tooltip], openclaw-tooltip")).toBeNull();
    vi.spyOn(identity!, "getBoundingClientRect").mockReturnValue({
      left: 12,
      right: 224,
      top: 700,
      width: 212,
    } as DOMRect);
    identity?.click();
    await sidebar.updateComplete;

    const menu = dom.query<HTMLElement>(".sidebar-identity-menu");
    const view = domProbe(menu!);
    expect(identity?.getAttribute("aria-expanded")).toBe("true");
    expect(menuItems(menu).map((element) => element.getAttribute("data-value"))).toEqual([
      "command:profile",
      "command:settings",
      "command:updates",
      "command:usage",
      "command:pair-mobile",
      "command:apps",
      "command:debug-overlay",
      "command:help",
    ]);
    for (const [root, selector, title] of [
      [identity, ".sidebar-identity-card__name", null],
      [menu, ".sidebar-identity-menu__name", fullName],
    ] as const) {
      const name = root?.querySelector(selector);
      expect(name?.textContent?.trim()).toBe(fullName);
      expectAttributes(name, { title });
      expectAttributes(root?.querySelector('[data-viewer-id="self"] img'), { src: avatarUrl });
    }
    const menuEmail = view.query(".sidebar-identity-menu__email");
    expect(menuEmail?.textContent?.trim()).toBe(email);
    expectAttributes(menuEmail, { title: email });
    expectAttributes(view.query(".sidebar-identity-menu__avatar"), { "aria-hidden": "true" });
    const shortcut = view.query('[data-value="command:settings"] .session-menu__shortcut');
    expect(shortcut?.textContent?.replace(/\s+/gu, "").trim()).toMatch(/^(⌘⇧,|Ctrl\+Shift\+,)$/u);
    expect(menu?.style.getPropertyValue("--sidebar-identity-menu-min-width")).toBe("212px");
    expect(view.query(".sidebar-pair-mobile")?.hasAttribute("disabled")).toBe(true);
    const buildChip = view.query("openclaw-sidebar-build-chip");
    expect(buildChip).not.toBeNull();
    expect(buildChip?.variant).toBe("identity");
    expect(view.query("openclaw-theme-mode-toggle")).not.toBeNull();
    expect(menu?.textContent).not.toContain("Recent activity");
    expect(view.all(':scope > [role="separator"]')).toHaveLength(4);
    expect(card.query(".sidebar-identity-card__more")).toBeNull();
    expect(card.query(".sidebar-identity-card__chevron")).toBeNull();

    const helpRow = view.query<HTMLElement>(".sidebar-identity-menu__help");
    await (helpRow as (HTMLElement & { updateComplete?: Promise<unknown> }) | null)?.updateComplete;
    expect(helpRow?.getAttribute("aria-haspopup")).toBe("menu");
    expect(
      [...(helpRow?.parentElement?.querySelectorAll('[role="menu"] a[href]') ?? [])].map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual([
      "https://docs.openclaw.ai",
      "https://docs.openclaw.ai/help",
      "https://discord.gg/clawd",
      "https://docs.openclaw.ai/releases",
    ]);

    view.query<HTMLElement>('[data-value="command:profile"]')?.focus();
    menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sidebar.updateComplete;
    expect(dom.query(".sidebar-identity-menu")).toBeNull();
    expect(document.activeElement).toBe(identity);

    identity?.click();
    await sidebar.updateComplete;
    const reopened = dom.query<HTMLElement>(".sidebar-identity-menu");
    const profile = reopened?.querySelector<HTMLElement>('[data-value="command:profile"]');
    profile?.click();
    await sidebar.updateComplete;
    expect(onNavigate).toHaveBeenCalledWith("profile", { hash: "#settings-profile-identity" });
    expect(dom.query(".sidebar-identity-menu")).toBeNull();
  });

  it.each([false, true])(
    "traverses footer controls without losing the active menu item (offline: %s)",
    async (offline) => {
      const { sidebar, dom } = await mountIdentity();
      sidebar.connected = true;
      sidebar.canPairDevice = false;
      sidebar.connectionStatus = offline ? "reconnecting" : null;
      await sidebar.updateComplete;

      const identity = dom.query<HTMLButtonElement>(".sidebar-identity-card");
      identity?.click();
      await sidebar.updateComplete;

      const menu = dom.query<HTMLElement>(".sidebar-identity-menu");
      const view = domProbe(menu!);
      const items = menuItems(menu, true);
      const lastItem = items.at(-1);
      const theme = view.query<HTMLButtonElement>(".theme-mode-toggle");
      const build = view.query<HTMLAnchorElement>(".sidebar-footer-build");
      const arrow = async (
        target: HTMLElement | null | undefined,
        key: "ArrowDown" | "ArrowUp",
      ) => {
        target?.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
        await sidebar.updateComplete;
      };
      lastItem?.focus();
      await arrow(lastItem, "ArrowDown");
      if (build) {
        expect(document.activeElement).toBe(build);
        await arrow(build, "ArrowDown");
      }
      expect(document.activeElement).toBe(theme);
      await arrow(theme, "ArrowUp");
      if (build) {
        expect(document.activeElement).toBe(build);
        await arrow(build, "ArrowUp");
      }
      expect(document.activeElement).toBe(lastItem);
      expect(lastItem?.getAttribute("data-highlighted")).not.toBeNull();

      items[0]?.focus();
      await arrow(items[0], "ArrowUp");
      expect(document.activeElement).toBe(theme);
      await arrow(theme, "ArrowDown");
      expect(document.activeElement).toBe(items[0]);
    },
  );
});

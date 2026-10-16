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
import { waitForSolid } from "../solid-settle.ts";
import "../../components/app-sidebar.tsx";

describe("AppSidebar footer identity menu", () => {
  it("opens Profile from the Owner header without a self user", async () => {
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
    );
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card")?.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    const header = menu?.querySelector<HTMLElement>('[data-value="command:profile"]');
    expect(header?.querySelector(".sidebar-identity-menu__name")?.textContent?.trim()).toBe(
      "Owner",
    );
    expect(header?.querySelector('[data-viewer-id="owner"]')?.textContent).toContain("O");
    header?.click();
    await sidebar.updateComplete;
    expect(onNavigate).toHaveBeenCalledWith("profile", {
      hash: "#settings-profile-identity",
    });
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
    sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card")?.click();
    await sidebar.updateComplete;
    const updates = () => sidebar.querySelector<HTMLElement>('[data-value="command:updates"]');
    expect(updates()?.textContent).toContain("Available");
    expect(updates()?.getAttribute("aria-label")).toBe("Updates. Update available");
    expect(sidebar.querySelector(".sidebar-footer-build__update")).toBeNull();

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
    const gatewayHarness = createGatewayHarness({
      instanceId: "self-instance",
    } as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.canPairDevice = false;
    sidebar.onNavigate = onNavigate;
    gatewayHarness.publish({
      selfUser: {
        id: "self",
        name: fullName,
        email: "ada.with.a.deliberately.long.address@example.test",
        avatarUrl: "/api/users/self/avatar?v=1",
      },
    });
    await sidebar.updateComplete;

    const identity = sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card");
    expect(identity?.getAttribute("aria-haspopup")).toBe("menu");
    expect(identity?.getAttribute("aria-expanded")).toBe("false");
    expect(identity?.getAttribute("aria-label")).toContain(fullName);
    expect(identity?.querySelector("[title], [data-tooltip], openclaw-tooltip")).toBeNull();
    vi.spyOn(identity!, "getBoundingClientRect").mockReturnValue({
      left: 12,
      right: 224,
      top: 700,
      width: 212,
    } as DOMRect);
    identity?.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    expect(identity?.getAttribute("aria-expanded")).toBe("true");
    expect(
      [...(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"][data-value]') ?? [])]
        .filter(
          (element) =>
            element.closest('[role="menu"]') === menu &&
            !element.closest(".sidebar-identity-menu__footer"),
        )
        .map((element) => element.getAttribute("data-value")),
    ).toEqual([
      "command:profile",
      "command:settings",
      "command:updates",
      "command:usage",
      "command:pair-mobile",
      "command:apps",
      "command:debug-overlay",
      "command:help",
    ]);
    const footerName = identity?.querySelector(".sidebar-identity-card__name");
    const menuName = menu?.querySelector(".sidebar-identity-menu__name");
    expect(footerName?.textContent?.trim()).toBe(fullName);
    expect(footerName?.hasAttribute("title")).toBe(false);
    expect(menuName?.textContent?.trim()).toBe(fullName);
    expect(menuName?.getAttribute("title")).toBe(fullName);
    const menuEmail = menu?.querySelector(".sidebar-identity-menu__email");
    expect(menuEmail?.textContent?.trim()).toBe(
      "ada.with.a.deliberately.long.address@example.test",
    );
    expect(menuEmail?.getAttribute("title")).toBe(
      "ada.with.a.deliberately.long.address@example.test",
    );
    expect(menu?.querySelector(".sidebar-identity-menu__avatar")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(menu?.querySelector('[data-viewer-id="self"] img')?.getAttribute("src")).toBe(
      "/api/users/self/avatar?v=1",
    );
    expect(identity?.querySelector('[data-viewer-id="self"] img')?.getAttribute("src")).toBe(
      "/api/users/self/avatar?v=1",
    );
    expect(
      menu
        ?.querySelector('[data-value="command:settings"] .session-menu__shortcut')
        ?.textContent?.replace(/\s+/gu, "")
        .trim(),
    ).toMatch(/^(⌘⇧,|Ctrl\+Shift\+,)$/u);
    expect(menu?.style.getPropertyValue("--sidebar-identity-menu-min-width")).toBe("212px");
    expect(menu?.querySelector(".sidebar-pair-mobile")?.hasAttribute("disabled")).toBe(true);
    expect(menu?.querySelector("openclaw-sidebar-build-chip")).not.toBeNull();
    expect(
      (menu?.querySelector("openclaw-sidebar-build-chip") as { variant?: string } | null)?.variant,
    ).toBe("identity");
    expect(menu?.querySelector("openclaw-theme-mode-toggle")).not.toBeNull();
    expect(menu?.textContent).not.toContain("Recent activity");
    expect(menu?.querySelectorAll(':scope > [role="separator"]')).toHaveLength(4);
    expect(identity?.querySelector(".sidebar-identity-card__more")).toBeNull();
    expect(identity?.querySelector(".sidebar-identity-card__chevron")).toBeNull();

    const helpRow = menu?.querySelector<HTMLElement>(".sidebar-identity-menu__help");
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

    menu?.querySelector<HTMLElement>('[data-value="command:profile"]')?.focus();
    menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-identity-menu")).toBeNull();
    expect(document.activeElement).toBe(identity);

    identity?.click();
    await sidebar.updateComplete;
    const reopened = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    const profile = reopened?.querySelector<HTMLElement>('[data-value="command:profile"]');
    profile?.click();
    await sidebar.updateComplete;
    expect(onNavigate).toHaveBeenCalledWith("profile", { hash: "#settings-profile-identity" });
    expect(sidebar.querySelector(".sidebar-identity-menu")).toBeNull();
  });

  it.each([false, true])(
    "traverses footer controls without losing the active menu item (offline: %s)",
    async (offline) => {
      const { sidebar } = await mountSidebar(
        createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      sidebar.canPairDevice = false;
      sidebar.connectionStatus = offline ? "reconnecting" : null;
      await sidebar.updateComplete;

      const identity = sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card");
      identity?.click();
      await sidebar.updateComplete;

      const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
      const items = [
        ...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"][data-value]') ?? []),
      ].filter(
        (item) =>
          item.closest('[role="menu"]') === menu &&
          !item.hasAttribute("disabled") &&
          !item.closest(".sidebar-identity-menu__footer"),
      );
      const lastItem = items.at(-1);
      const theme = menu?.querySelector<HTMLButtonElement>(".theme-mode-toggle");
      const build = menu?.querySelector<HTMLAnchorElement>(".sidebar-footer-build");
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

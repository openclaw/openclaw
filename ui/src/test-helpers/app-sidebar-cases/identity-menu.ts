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
  mountSidebarContext,
} from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { waitForSolid } from "../solid-settle.ts";
import { sidebarDriver } from "./sidebar-driver.test-support.ts";
import "../../components/app-sidebar.tsx";

async function mountIdentity(
  prepare?: (
    context: ReturnType<typeof createContext>,
    gateway: ReturnType<typeof createGatewayHarness>,
  ) => void,
) {
  const gateway = createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient);
  const context = createContext(gateway.gateway, createSessions("main", ["agent:main:main"]));
  prepare?.(context, gateway);
  const { sidebar } = await mountSidebarContext(context);
  const navigate = vi.fn();
  sidebar.onNavigate = navigate;
  const dom = sidebarDriver(sidebar);
  return { gateway, context, dom, navigate, open: () => dom.click(".sidebar-identity-card") };
}

describe("AppSidebar footer identity menu", () => {
  it("opens Profile from the Owner header without a self user", async () => {
    const { dom, navigate, open } = await mountIdentity();
    await open();

    const header = dom.query<HTMLElement>('[data-value="command:profile"]');
    const profile = domProbe(header!);
    expect(profile.text(".sidebar-identity-menu__name")?.trim()).toBe("Owner");
    expect(profile.text('[data-viewer-id="owner"]')).toContain("O");
    await dom.click(header!);
    expect(navigate).toHaveBeenCalledWith("profile", { hash: "#settings-profile-identity" });
    expect(dom.query(".sidebar-identity-menu")).toBeNull();
  });

  it("keeps release availability on Updates after dismissing the Inbox notice", async () => {
    const subscribers = new Set<Parameters<ApplicationOverlays["subscribe"]>[0]>();
    const { gateway, context, dom, open } = await mountIdentity((ctx, harness) => {
      const hello = harness.gateway.snapshot.hello!;
      harness.publish({
        selfUser: { id: "alice", name: "Alice" },
        hello: { ...hello, server: { ...hello.server, bootId: "boot-a" } },
      });
      vi.mocked(ctx.overlays.subscribe).mockImplementation((notify) => {
        subscribers.add(notify);
        return () => subscribers.delete(notify);
      });
    });
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
    expect(dismissal).not.toBeNull();
    dismissSidebarAttention(resolveSidebarAttentionKey(gateway.gateway), dismissal!);
    await open();
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

  it("shows account identity, utilities, and pairing access", async () => {
    const fullName = "Ada Lovelace With A Deliberately Long Display Name";
    const email = "ada.with.a.deliberately.long.address@example.test";
    const avatarUrl = "/api/users/self/avatar?v=1";
    const { gateway, dom, open } = await mountIdentity();
    await dom.update({ connected: true, canPairDevice: false });
    gateway.publish({ selfUser: { id: "self", name: fullName, email, avatarUrl } });
    await dom.update();

    const identity = dom.query<HTMLButtonElement>(".sidebar-identity-card");
    const card = domProbe(identity!);
    expect(identity).toMatchObject({ ariaHasPopup: "menu", ariaExpanded: "false" });
    expect(identity?.getAttribute("aria-label")).toContain(fullName);
    expect(card.query("[title], [data-tooltip], openclaw-tooltip")).toBeNull();
    await open();

    const menu = dom.query<HTMLElement>(".sidebar-identity-menu");
    const view = domProbe(menu!);
    expect(identity?.getAttribute("aria-expanded")).toBe("true");
    expect(card.text(".sidebar-identity-card__name")?.trim()).toBe(fullName);
    for (const [field, value] of Object.entries({ name: fullName, email })) {
      const detail = view.query(`.sidebar-identity-menu__${field}`);
      expect(detail).toMatchObject({ textContent: value, title: value });
    }
    for (const subject of [card, view]) {
      expect(subject.attr('[data-viewer-id="self"] img', "src")).toBe(avatarUrl);
    }
    expect(view.attr(".sidebar-identity-menu__avatar", "aria-hidden")).toBe("true");
    const shortcut = view.query('[data-value="command:settings"] .session-menu__shortcut');
    expect(shortcut?.textContent?.replace(/\s+/gu, "").trim()).toMatch(/^(⌘⇧,|Ctrl\+Shift\+,)$/u);
    expect(view.query(".sidebar-pair-mobile")?.hasAttribute("disabled")).toBe(true);

    const helpRow = view.query<HTMLElement>(".sidebar-identity-menu__help");
    expect(helpRow?.getAttribute("aria-haspopup")).toBe("menu");
    const links = domProbe(helpRow!.parentElement!).all('[role="menu"] a[href]');
    const support = [...links].find((link) => link.textContent?.includes("Get support"));
    expect(support?.getAttribute("href")).toBe("https://community.openclaw.ai/");
  });

  it("keeps one account avatar and photo while the open menu rebuilds", async () => {
    const avatarUrl = "/api/users/self/avatar?v=1";
    const { gateway, dom, open } = await mountIdentity();
    await dom.update({ connected: true, canPairDevice: false });
    const user = { id: "self", name: "Ada", email: "ada@example.test", avatarUrl };
    gateway.publish({ selfUser: user });
    await dom.update();
    await open();
    const photo = () => dom.query<HTMLImageElement>(".sidebar-identity-menu__avatar img");
    const mounted = photo();
    expect(mounted?.getAttribute("src")).toBe(avatarUrl);

    await dom.update({ canPairDevice: true });
    await waitForSolid(() => {
      expect(dom.query(".sidebar-pair-mobile")?.hasAttribute("disabled")).toBe(false);
    });
    gateway.publish({ selfUser: { ...user, name: "Ada Lovelace" } });
    await waitForSolid(() => {
      expect(dom.query(".sidebar-identity-menu__name")?.textContent).toBe("Ada Lovelace");
    });
    expect(photo()).toBe(mounted);
  });

  it("wraps between Profile and the footer while reconnecting", async () => {
    const { dom, open } = await mountIdentity();
    await dom.update({ connected: true, canPairDevice: false, connectionStatus: "reconnecting" });
    await open();
    const profile = dom.query<HTMLElement>('[data-value="command:profile"]');
    const theme = dom.query<HTMLButtonElement>(".sidebar-identity-menu .theme-mode-toggle");
    profile!.focus();
    await dom.key(profile, "ArrowUp");
    await waitForSolid(() => expect(document.activeElement).toBe(theme));
    await dom.key(theme, "ArrowDown");
    await waitForSolid(() => expect(document.activeElement).toBe(profile));
  });
});

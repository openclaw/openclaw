import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getAppSidebarOwner } from "../../components/app-sidebar.tsx";
import { createSidebarTestRouter } from "../app-sidebar-router.ts";
import { createGatewayHarness, createSessionsHarness } from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { mountSidebarFixture as mountFooter } from "./compact.test-support.ts";
import { patchRows, settleRoster } from "./roster.test-support.ts";

async function mountIdentity() {
  const gateway = createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient);
  const dom = await mountFooter(gateway.gateway);
  const navigate = vi.fn();
  dom.sidebar.onNavigate = navigate;
  return { gateway, dom, navigate, open: () => dom.click(".sidebar-identity-card") };
}

describe("AppSidebar footer", () => {
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

  it("owns account utilities and restores focus", async () => {
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
    vi.spyOn(identity!, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 700, 212));
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
    expect(menu?.style.getPropertyValue("--sidebar-identity-menu-min-width")).toBe("212px");
    expect(view.query(".sidebar-pair-mobile")?.hasAttribute("disabled")).toBe(true);

    const helpRow = view.query<HTMLElement>(".sidebar-identity-menu__help");
    expect(helpRow?.getAttribute("aria-haspopup")).toBe("menu");
    const links = domProbe(helpRow!.parentElement!).all('[role="menu"] a[href]');
    expect([...links].map((link) => link.getAttribute("href"))).toEqual([
      "https://docs.openclaw.ai",
      "https://community.openclaw.ai/",
      "https://discord.gg/clawd",
      "https://docs.openclaw.ai/releases",
    ]);

    expect([...links].find((link) => link.textContent?.includes("Get support"))).toBeDefined();

    view.query<HTMLElement>('[data-value="command:profile"]')?.focus();
    await dom.key(menu, "Escape", { cancelable: false });
    expect(dom.query(".sidebar-identity-menu")).toBeNull();
    expect(document.activeElement).toBe(identity);
  });

  it("wraps keyboard focus across the footer while reconnecting", async () => {
    const { dom, open } = await mountIdentity();
    await dom.update({
      connected: true,
      canPairDevice: false,
      connectionStatus: "reconnecting",
    });
    await open();

    const menu = dom.query<HTMLElement>(".sidebar-identity-menu");
    const view = domProbe(menu!);
    const first = menu?.querySelector<HTMLElement>('[role="menuitem"][data-value]:not([disabled])');
    const theme = view.query<HTMLButtonElement>(".theme-mode-toggle");
    first?.focus();
    await dom.key(first, "ArrowUp");
    expect(document.activeElement).toBe(theme);
    await dom.key(theme, "ArrowDown");
    expect(document.activeElement).toBe(first);
  });
  it.each(["online", "contextual"] as const)(
    "updates Home activity while the session list is hidden by %s",
    async (surface) => {
      const mainKey = "agent:main:main";
      const otherKey = "agent:main:other";
      const sessions = createSessionsHarness("main", [mainKey, otherKey]);
      const { sidebar, q } = await mountFooter(undefined, sessions.sessions);
      sidebar.connected = true;
      if (surface === "online") {
        sidebar.navigationView = "online";
      } else {
        const router = createSidebarTestRouter();
        sidebar.router = router;
        await router.navigate("systems", {});
      }
      await settleRoster(sidebar);
      const home = q(".sidebar-footer-bar__home")!;
      expect(home.querySelector(".session-glyph__ring")).toBeNull();
      const prepare = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "prepareRender");
      const publishRow = (key: string, patch: Parameters<typeof patchRows>[2]) => {
        const latest = sessions.sessions.state.result!;
        sessions.publish({
          result: { ...latest, sessions: patchRows(latest.sessions, key, patch) },
        });
      };
      publishRow(otherKey, { label: "Quiet latest title" });
      await settleRoster(sidebar);
      expect(prepare).not.toHaveBeenCalled();

      const activity = [
        [true, "running", false],
        [false, "done", true],
      ] as const;
      for (const [index, [hasActiveRun, status, unread]] of activity.entries()) {
        publishRow(mainKey, { hasActiveRun, status, unread });
        await settleRoster(sidebar);
        expect(home.querySelector(".session-glyph__ring") !== null).toBe(hasActiveRun);
        expect(home.querySelector('[aria-label="Unread"]') !== null).toBe(unread);
        expect(prepare).toHaveBeenCalledTimes(index + 1);
      }
    },
  );

  it("retains display identity only for the same reconnecting connection", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const alex = { id: "profile-alex", name: "Alex" };
    gateway.publish({ selfUser: alex });
    const { sidebar, q } = await mountFooter(gateway.gateway);
    const expectName = async (expected: string) => {
      await sidebar.updateComplete;
      expect(q(".sidebar-identity-card__name")?.textContent).toBe(expected);
    };
    await expectName("Alex");

    gateway.publish({ phase: "reconnecting", selfUser: null });
    sidebar.connectionStatus = "reconnecting";
    await expectName("Alex");

    Object.defineProperty(gateway.gateway, "connectionRevision", { value: 1 });
    sidebar.sessionData.presenceInstanceId = "old-connection";
    const presencePayload = { presence: [{ instanceId: "old-connection", ts: 1, user: alex }] };
    sidebar.sessionData.presencePayload = presencePayload;
    sidebar.invalidate();
    await expectName("Owner");
    gateway.publish({ phase: "connected", selfUser: null });
    sidebar.sessionData.presencePayload = presencePayload;
    await expectName("Owner");

    gateway.publish({ phase: "connected", selfUser: { id: "profile-sam", name: "Sam" } });
    await expectName("Sam");
    gateway.publish({ phase: "stopped", selfUser: null });
    await expectName("Owner");
  });
});

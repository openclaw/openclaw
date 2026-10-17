import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { CONTROL_UI_BUILD_INFO, type ControlUiBuildInfo } from "../../build-info.ts";
import { getAppSidebarOwner } from "../../components/app-sidebar.tsx";
import { createSidebarTestRouter } from "../app-sidebar-router.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import { settleRoster } from "./roster.test-support.ts";

type SidebarNativeGatewayTestSnapshot = {
  gateways: Array<{
    id: string;
    name: string;
    isPrimary: boolean;
    health: "ok" | "error" | "unknown";
  }>;
  currentId: string;
};

type SidebarNativeGatewayTestWindow = Window & {
  __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
  __OPENCLAW_NATIVE_GATEWAYS__?: SidebarNativeGatewayTestSnapshot;
};

type MutableControlUiBuildInfo = {
  -readonly [Key in keyof ControlUiBuildInfo]: ControlUiBuildInfo[Key];
};

const ORIGINAL_CONTROL_UI_BUILD_INFO = { ...CONTROL_UI_BUILD_INFO };
const CONTROL_UI_TEST_COMMIT = "e8cbc62f0123456789abcdef0123456789abcdef";

function setControlUiBuildInfo(overrides: Partial<ControlUiBuildInfo>): void {
  Object.assign(
    CONTROL_UI_BUILD_INFO as MutableControlUiBuildInfo,
    ORIGINAL_CONTROL_UI_BUILD_INFO,
    overrides,
  );
}

function setNativeGatewayTestState(snapshot: SidebarNativeGatewayTestSnapshot): void {
  const nativeWindow = window as SidebarNativeGatewayTestWindow;
  nativeWindow["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
  nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"] = snapshot;
}

describe("AppSidebar gateway footer subtitle", () => {
  afterEach(() => {
    const nativeWindow = window as SidebarNativeGatewayTestWindow;
    Reflect.deleteProperty(nativeWindow, "__OPENCLAW_NATIVE_WEB_CHROME__");
    Reflect.deleteProperty(nativeWindow, "__OPENCLAW_NATIVE_GATEWAYS__");
    Object.assign(
      CONTROL_UI_BUILD_INFO as MutableControlUiBuildInfo,
      ORIGINAL_CONTROL_UI_BUILD_INFO,
    );
  });

  const twoGateways = {
    gateways: [
      { id: "local", name: "Local Gateway", isPrimary: true, health: "ok" },
      { id: "remote", name: "Remote Gateway", isPrimary: false, health: "unknown" },
    ],
    currentId: "local",
  } satisfies SidebarNativeGatewayTestSnapshot;

  it.each(["online", "contextual"] as const)(
    "updates Home activity while the session list is hidden by %s",
    async (surface) => {
      const mainKey = "agent:main:main";
      const otherKey = "agent:main:other";
      const sessions = createSessionsHarness("main", [mainKey, otherKey]);
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        sessions.sessions,
      );
      sidebar.connected = true;
      if (surface === "online") {
        sidebar.navigationView = "online";
      } else {
        const router = createSidebarTestRouter();
        sidebar.router = router;
        await router.navigate("systems", {});
      }
      await settleRoster(sidebar);
      const home = sidebar.querySelector(".sidebar-footer-bar__home")!;
      expect(home).not.toBeNull();
      expect(home.querySelector(".session-glyph__ring")).toBeNull();
      const prepare = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "prepareRender");
      const current = sessions.sessions.state.result!;
      sessions.publish({
        result: Object.assign({}, current, {
          sessions: current.sessions.map((row) =>
            row.key === otherKey ? Object.assign({}, row, { label: "Quiet latest title" }) : row,
          ),
        }),
      });
      await settleRoster(sidebar);
      expect(prepare).not.toHaveBeenCalled();

      for (const [index, activity] of (
        [
          { hasActiveRun: true, status: "running", unread: false },
          { hasActiveRun: false, status: "done", unread: true },
        ] as const
      ).entries()) {
        const latest = sessions.sessions.state.result!;
        sessions.publish({
          result: Object.assign({}, latest, {
            sessions: latest.sessions.map((row) =>
              row.key === mainKey ? Object.assign({}, row, activity) : row,
            ),
          }),
        });
        await settleRoster(sidebar);
        expect(home.querySelector(".session-glyph__ring") !== null).toBe(activity.hasActiveRun);
        expect(home.querySelector('[aria-label="Unread"]') !== null).toBe(activity.unread);
        expect(prepare).toHaveBeenCalledTimes(index + 1);
      }
    },
  );

  it("shows custom build provenance and hides official releases", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T16:00:00.000Z"));
    setControlUiBuildInfo({
      commit: CONTROL_UI_TEST_COMMIT,
      commitAt: "2026-07-10T12:00:00.000Z",
      branch: "main",
      dirty: false,
      release: false,
    });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.connected = true;
    sidebar.gatewayStatus = { kind: "connected" };
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Owner: git@e8cbc62 · 4h ago",
    );

    setControlUiBuildInfo({
      commit: CONTROL_UI_TEST_COMMIT,
      commitAt: "2026-07-10T12:00:00.000Z",
      branch: "main",
      dirty: false,
      release: true,
    });
    sidebar.invalidate();
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Owner",
    );
    expect(sidebar.querySelector(".sidebar-identity-card__gateway")).toBeNull();
  });

  it("shows gateway identity without treating aggregate health as this window’s status", async () => {
    setControlUiBuildInfo({ commit: CONTROL_UI_TEST_COMMIT, release: false });
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Owner: Local Gateway, primary",
    );
    const detail = sidebar.querySelector(".sidebar-identity-card__gateway");
    expect(detail?.textContent).toContain("Local Gateway");
    expect(detail?.querySelector(".sidebar-gateway-primary")?.textContent).toBe("primary");
    expect(detail?.querySelector(".sidebar-gateway-health")).toBeNull();
    expect(
      sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label"),
    ).not.toContain("git@e8cbc62");
  });

  it("shows nonhealthy state as the avatar dot and leaves announcing to the shell", async () => {
    const label = "Suspended";
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.connectionStatus = "suspended";
    await sidebar.updateComplete;

    const footer = sidebar.querySelector(".sidebar-footer-bar");
    const card = footer?.querySelector(".sidebar-identity-card");
    // The shell chip owns the written label; the footer keeps the dot and accessible name.
    expect(footer?.querySelector(".gateway-status__label")).toBeNull();
    expect(card?.getAttribute("data-connection-status")).toBe("suspended");
    expect(card?.querySelector(".sidebar-identity-card__status")).not.toBeNull();
    expect(card?.getAttribute("aria-label")).toBe(`Identity and app menu for Owner: ${label}`);
    expect(footer?.querySelector(":scope > [role=status]")).toBeNull();
    expect(footer?.querySelector(".sidebar-identity-card__name")?.textContent).toBe("Owner");
    expect(footer?.querySelector(".sidebar-identity-card__gateway")?.textContent).toContain(
      "Local Gateway",
    );
  });

  it("returns to the healthy dot and gateway identity after reconnect", async () => {
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.connectionStatus = "reconnecting";
    await sidebar.updateComplete;
    const card = () => sidebar.querySelector(".sidebar-identity-card");
    expect(card()?.getAttribute("data-connection-status")).toBe("reconnecting");

    sidebar.connectionStatus = null;
    sidebar.connected = true;
    sidebar.gatewayStatus = { kind: "connected" };
    sidebar.connectionRecovery = true;
    await sidebar.updateComplete;
    expect(card()?.getAttribute("data-connection-status")).toBe("connected");
    expect(card()?.getAttribute("aria-label")).toBe("Identity and app menu for Owner: Connected");

    sidebar.connectionRecovery = false;
    await sidebar.updateComplete;
    expect(card()?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Owner: Local Gateway, primary",
    );
    sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card")?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-identity-menu__outbox")).toBeNull();
    expect(sidebar.querySelector(".sidebar-footer-bar")?.textContent).not.toContain("in outbox");
  });

  it("updates when the native gateway snapshot changes", async () => {
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    setNativeGatewayTestState({
      gateways: [
        { id: "local", name: "Local Gateway", isPrimary: true, health: "ok" },
        { id: "remote", name: "Remote Gateway", isPrimary: false, health: "error" },
      ],
      currentId: "remote",
    });
    window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed"));
    await sidebar.updateComplete;

    const ariaLabel = sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label");
    expect(ariaLabel).toContain("Remote Gateway");
    expect(ariaLabel).not.toContain("primary");
    const detail = sidebar.querySelector(".sidebar-identity-card__gateway");
    expect(detail?.textContent).toContain("Remote Gateway");
    expect(detail?.querySelector(".sidebar-gateway-primary")).toBeNull();
    expect(detail?.querySelector(".sidebar-gateway-health")).toBeNull();
  });

  it("retains display identity only for the same reconnecting connection", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({ selfUser: { id: "profile-alex", name: "Alex" } });
    const { sidebar } = await mountSidebar(
      gateway.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    const name = () => sidebar.querySelector(".sidebar-identity-card__name")?.textContent;
    expect(name()).toBe("Alex");

    gateway.publish({ phase: "reconnecting", selfUser: null });
    sidebar.connectionStatus = "reconnecting";
    await sidebar.updateComplete;
    expect(name()).toBe("Alex");
    expect(gateway.gateway.snapshot.selfUser).toBeNull();

    Object.defineProperty(gateway.gateway, "connectionRevision", { value: 1 });
    sidebar.sessionData.presenceInstanceId = "old-connection";
    sidebar.sessionData.presencePayload = {
      presence: [
        { instanceId: "old-connection", ts: 1, user: { id: "profile-alex", name: "Alex" } },
      ],
    };
    sidebar.invalidate();
    await sidebar.updateComplete;
    expect(name()).toBe("Owner");
    gateway.publish({ phase: "connected", selfUser: null });
    sidebar.sessionData.presencePayload = {
      presence: [
        { instanceId: "old-connection", ts: 1, user: { id: "profile-alex", name: "Alex" } },
      ],
    };
    await sidebar.updateComplete;
    expect(name()).toBe("Owner");

    gateway.publish({ phase: "connected", selfUser: { id: "profile-sam", name: "Sam" } });
    await sidebar.updateComplete;
    expect(name()).toBe("Sam");
    gateway.publish({ phase: "stopped", selfUser: null });
    await sidebar.updateComplete;
    expect(name()).toBe("Owner");
  });
});

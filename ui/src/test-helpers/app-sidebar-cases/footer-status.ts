import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { NativeGateway } from "../../app/native-gateways.runtime.ts";
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

type NativeGatewaysSnapshot = {
  gateways: Array<Pick<NativeGateway, "id" | "name" | "isPrimary" | "health">>;
  currentId: string;
};

const ORIGINAL_CONTROL_UI_BUILD_INFO = { ...CONTROL_UI_BUILD_INFO };
const CONTROL_UI_TEST_COMMIT = "e8cbc62f0123456789abcdef0123456789abcdef";

function setControlUiBuildInfo(overrides: Partial<ControlUiBuildInfo>): void {
  Object.assign(CONTROL_UI_BUILD_INFO, ORIGINAL_CONTROL_UI_BUILD_INFO, overrides);
}

function setNativeGatewayTestState(snapshot: NativeGatewaysSnapshot): void {
  Object.assign(window, {
    __OPENCLAW_NATIVE_WEB_CHROME__: true,
    __OPENCLAW_NATIVE_GATEWAYS__: snapshot,
  });
}

async function mountFooter(
  gateway = createGateway({} as GatewayBrowserClient),
  sessions = createSessions("main", ["agent:main:main"]),
) {
  const { sidebar } = await mountSidebar(gateway, sessions);
  const q = (selector: string) => sidebar.querySelector<HTMLElement>(selector);
  return {
    sidebar,
    q,
    label: () => q(".sidebar-identity-card")?.getAttribute("aria-label"),
    name: () => q(".sidebar-identity-card__name")?.textContent,
  };
}

describe("AppSidebar gateway footer subtitle", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
    Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_GATEWAYS__");
    Object.assign(CONTROL_UI_BUILD_INFO, ORIGINAL_CONTROL_UI_BUILD_INFO);
  });

  const twoGateways = {
    gateways: [
      { id: "local", name: "Local Gateway", isPrimary: true, health: "ok" },
      { id: "remote", name: "Remote Gateway", isPrimary: false, health: "unknown" },
    ],
    currentId: "local",
  } satisfies NativeGatewaysSnapshot;

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
      expect(home).not.toBeNull();
      expect(home.querySelector(".session-glyph__ring")).toBeNull();
      const prepare = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "prepareRender");
      const current = sessions.sessions.state.result!;
      const publishRow = (key: string, patch: Partial<(typeof current.sessions)[number]>) => {
        const latest = sessions.sessions.state.result!;
        sessions.publish({
          result: {
            ...latest,
            sessions: latest.sessions.map((row) =>
              row.key === key ? Object.assign({}, row, patch) : row,
            ),
          },
        });
      };
      publishRow(otherKey, { label: "Quiet latest title" });
      await settleRoster(sidebar);
      expect(prepare).not.toHaveBeenCalled();

      for (const [index, activity] of (
        [
          { hasActiveRun: true, status: "running", unread: false },
          { hasActiveRun: false, status: "done", unread: true },
        ] as const
      ).entries()) {
        publishRow(mainKey, activity);
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
    const build = {
      commit: CONTROL_UI_TEST_COMMIT,
      commitAt: "2026-07-10T12:00:00.000Z",
      branch: "main",
      dirty: false,
    };
    setControlUiBuildInfo({ ...build, release: false });
    const { sidebar, q, label } = await mountFooter();
    sidebar.connected = true;
    sidebar.gatewayStatus = { kind: "connected" };
    await sidebar.updateComplete;

    expect(label()).toBe("Identity and app menu for Owner: git@e8cbc62 · 4h ago");

    setControlUiBuildInfo({ ...build, release: true });
    sidebar.invalidate();
    await sidebar.updateComplete;

    expect(label()).toBe("Identity and app menu for Owner");
    expect(q(".sidebar-identity-card__gateway")).toBeNull();
  });

  it.each([false, true])(
    "shows gateway identity without aggregate health (changed: %s)",
    async (changed) => {
      setControlUiBuildInfo({ commit: CONTROL_UI_TEST_COMMIT, release: false });
      setNativeGatewayTestState(twoGateways);
      const { sidebar, q, label } = await mountFooter();
      if (changed) {
        setNativeGatewayTestState({
          gateways: twoGateways.gateways.map((gateway) =>
            Object.assign({}, gateway, { health: gateway.isPrimary ? "ok" : "error" }),
          ),
          currentId: "remote",
        });
        window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed"));
        await sidebar.updateComplete;
      }
      const detail = q(".sidebar-identity-card__gateway");
      expect(label()).toBe(
        `Identity and app menu for Owner: ${changed ? "Remote Gateway" : "Local Gateway, primary"}`,
      );
      expect(label()).not.toContain("git@e8cbc62");
      expect(detail?.querySelector(".sidebar-gateway-primary")?.textContent ?? null).toBe(
        changed ? null : "primary",
      );
      expect(detail?.textContent).toContain(changed ? "Remote Gateway" : "Local Gateway");
      expect(detail?.querySelector(".sidebar-gateway-health")).toBeNull();
    },
  );

  it("shows nonhealthy state as the avatar dot and leaves announcing to the shell", async () => {
    const label = "Suspended";
    setNativeGatewayTestState(twoGateways);
    const { sidebar, q } = await mountFooter();
    sidebar.connectionStatus = "suspended";
    await sidebar.updateComplete;

    const footer = q(".sidebar-footer-bar");
    const card = footer?.querySelector(".sidebar-identity-card");
    // The shell owns the written label; the footer keeps the dot and accessible name.
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
    const { sidebar, q } = await mountFooter();
    sidebar.connectionStatus = "reconnecting";
    await sidebar.updateComplete;
    const card = () => q(".sidebar-identity-card");
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
    q(".sidebar-identity-card")?.click();
    await sidebar.updateComplete;
    expect(q(".sidebar-identity-menu__outbox")).toBeNull();
    expect(q(".sidebar-footer-bar")?.textContent).not.toContain("in outbox");
  });

  it("retains display identity only for the same reconnecting connection", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const alex = { id: "profile-alex", name: "Alex" };
    gateway.publish({ selfUser: alex });
    const { sidebar, name } = await mountFooter(gateway.gateway);
    const expectName = async (expected: string) => {
      await sidebar.updateComplete;
      expect(name()).toBe(expected);
    };
    expect(name()).toBe("Alex");

    gateway.publish({ phase: "reconnecting", selfUser: null });
    sidebar.connectionStatus = "reconnecting";
    await expectName("Alex");
    expect(gateway.gateway.snapshot.selfUser).toBeNull();

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

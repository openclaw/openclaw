import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { CONTROL_UI_BUILD_INFO, type ControlUiBuildInfo } from "../../build-info.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebar,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

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
    sidebar.requestUpdate();
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Owner",
    );
    expect(sidebar.querySelector(".sidebar-identity-card__gateway")).toBeNull();
  });

  it.each([null, "reconnecting"] as const)(
    "does not invent gateway metadata on the web (%s)",
    async (connectionStatus) => {
      const gateway = createGateway({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
      sidebar.connectionStatus = connectionStatus;
      await sidebar.updateComplete;

      expect(
        sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label"),
      ).not.toContain("Local Gateway");
      expect(sidebar.querySelector(".sidebar-identity-card__gateway")).toBeNull();
    },
  );

  it("shows a single configured gateway below the identity name", async () => {
    setNativeGatewayTestState({ gateways: [twoGateways.gateways[0]!], currentId: "local" });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Owner: Local Gateway, primary",
    );
    expect(sidebar.querySelector(".sidebar-identity-card__name")?.textContent).toBe("Owner");
    const detail = sidebar.querySelector(".sidebar-identity-card__gateway");
    expect(detail?.textContent).toContain("Local Gateway");
    expect(detail?.querySelector(".sidebar-gateway-primary")?.textContent).toBe("primary");
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

  it.each([
    ["reconnecting", "Reconnecting…"],
    ["restarting", "Restarting…"],
    ["suspending", "Suspending…"],
    ["suspended", "Suspended"],
    ["restoring", "Restoring…"],
    ["reload-required", "Refresh required"],
  ] as const)("shows one %s subtitle without delivery counts", async (connectionStatus, label) => {
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.connectionStatus = connectionStatus;
    await sidebar.updateComplete;

    const footer = sidebar.querySelector(".sidebar-footer-bar");
    expect(footer?.querySelectorAll(".gateway-status__label")).toHaveLength(1);
    expect(footer?.querySelector(".gateway-status__label")?.textContent).toBe(label);
    expect(footer?.querySelector("button [role=status]")).toBeNull();
    expect(footer?.querySelector("[role=status]")?.textContent).toContain(label);
    expect(footer?.querySelector("[role=status]")?.textContent).not.toContain("in outbox");
    expect(footer?.textContent).not.toContain("Offline");
    expect(footer?.querySelector(".gateway-status__outbox")).toBeNull();
    expect(footer?.querySelector(".sidebar-identity-card__name")?.textContent).toBe("Owner");
    expect(footer?.querySelector(".sidebar-identity-card__gateway")).toBeNull();
    expect(footer?.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(footer?.querySelector("button button")).toBeNull();
  });

  it("keeps gateway identity after reconnect and redacts connection diagnostics", async () => {
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.connectionStatus = "reconnecting";
    sidebar.lastError = "connection refused?token=footer-secret";
    await sidebar.updateComplete;
    const tooltip = sidebar.querySelector<HTMLElement & { content?: string }>(
      ".gateway-status-tooltip",
    );
    expect(tooltip?.content).toBe("connection refused?[redacted-credential]");

    sidebar.connectionStatus = null;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".gateway-status__label")).toBeNull();
    expect(sidebar.querySelector(".gateway-status__outbox")).toBeNull();
    expect(sidebar.querySelector(".sidebar-identity-card__gateway")?.textContent).toContain(
      "Local Gateway",
    );
    const connectedTooltip = sidebar.querySelector<HTMLElement & { content?: string }>(
      ".gateway-status-tooltip",
    );
    expect(connectedTooltip).toBeNull();
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
    sidebar.requestUpdate();
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

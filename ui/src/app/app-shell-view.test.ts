/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { render } from "@solidjs/testing-library";
import { createComponent, createRoot, flush, onSettled } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiHost, ControlUiReplacement } from "../../../src/plugin-sdk/control-ui.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import * as settingsSidebar from "../components/settings-sidebar-shell.tsx";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import type { SolidBridgeElement } from "../lib/solid-bridge.ts";
import "../plugins/control-ui-view.solid.tsx";
import type { ChatRouteData } from "../pages/chat/session-route-data.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { equalShellRouteState, selectShellRouteState } from "./app-host-route-state.ts";
import { ShellOwner } from "./app-host.tsx";
import { readShellView } from "./app-shell-view-state.ts";
import { ApplicationShell } from "./app-shell-view.tsx";
import { bootstrapApplication } from "./bootstrap.ts";
import { createSolidControlUiReadiness } from "./control-ui-readiness-solid.ts";
import { NATIVE_HISTORY_STATE_EVENT } from "./native-web-chrome.ts";
import { registerRouteElement } from "./route-elements.ts";

const sidebarImport = vi.hoisted(() => Promise.withResolvers<void>());
vi.mock("../components/app-sidebar.tsx", async (importOriginal) => {
  await sidebarImport.promise;
  return importOriginal();
});

setupSidebarTest();

function mockMobile(read: () => boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => Object.assign(new EventTarget(), { matches: read() })),
  );
}

async function mountShell(waitForSidebar = true) {
  const runtime = bootstrapApplication();
  const { owner, dispose } = createRoot((disposeRoot) => ({
    owner: new ShellOwner(document.createElement("openclaw-app-shell"), runtime),
    dispose: disposeRoot,
  }));
  owner.routeState = { routeId: "chat" };
  document.body.append(owner.element);
  const view = render(
    () => {
      onSettled(() => owner.mountPresentation());
      return createComponent(ApplicationProvider, {
        host: owner.element,
        value: runtime.context,
        get children() {
          return createComponent(ApplicationShell, { host: owner });
        },
      });
    },
    {
      container: owner.element,
    },
  );
  onTestFinished(() => {
    view.unmount();
    owner.disconnect();
    dispose();
    runtime.stop();
  });
  await Promise.resolve();
  if (waitForSidebar) {
    await vi.dynamicImportSettled();
  }
  flush();
  const refresh = () => {
    owner.invalidate();
    flush();
  };
  const query: typeof view.container.querySelector = view.container.querySelector.bind(
    view.container,
  );
  return { owner, runtime, view, query, refresh };
}

it("publishes readiness when the retained sidebar's delayed module commits", async () => {
  try {
    const { owner, runtime, view, query, refresh } = await mountShell(false);
    const sidebar = owner.navigationSidebar;
    const routerState = runtime.router.getState();
    vi.spyOn(runtime.router, "getState").mockReturnValue({
      ...routerState,
      status: "success",
      pendingMatches: [],
    });
    // mock-isolation: unrelated owner publications must not supply the missing mount notification.
    for (const source of [runtime.context.gateway, runtime.context.sessions, runtime.router]) {
      vi.spyOn(source, "subscribe").mockImplementation(() => () => {});
    }
    // The fixture's boot router has no committed route; present workspace chrome explicitly.
    owner.routeState = { routeId: "chat" };
    refresh();
    expect(owner.routeOutlet).toBeDefined();
    vi.spyOn(owner.routeOutlet!, "settlePresentation").mockResolvedValue(true);
    const { readiness, dispose } = createRoot((disposeRoot) => ({
      dispose: disposeRoot,
      readiness: createSolidControlUiReadiness(
        view.container,
        runtime,
        () => {},
        () => ({ shell: owner }),
      ),
    }));
    onTestFinished(() => {
      readiness.disconnect();
      dispose();
    });
    await waitForSolid(() => {
      expect(owner.readiness).toBe(readiness);
      expect(readiness.hook.snapshot()).toMatchObject({ booted: true, routeReady: false });
    });
    expect(sidebar.isConnected).toBe(false);
    sidebarImport.resolve();
    await vi.dynamicImportSettled();
    await customElements.whenDefined("openclaw-app-sidebar");
    await waitForSolid(() => {
      expect(customElements.get("openclaw-app-sidebar")).toBeDefined();
      expect(query("openclaw-app-sidebar")).toBe(sidebar);
      expect(readiness.hook.snapshot()).toMatchObject({ routeReady: true });
    });
  } finally {
    sidebarImport.resolve();
  }
});

it("exposes the Claws navigation entry only while its Labs toggle is enabled", async () => {
  const { owner, runtime } = await mountShell();
  const initial = runtime.context.runtimeConfig.state;
  const config = vi.spyOn(runtime.context.runtimeConfig, "state", "get");
  for (const enabled of [false, true, false]) {
    config.mockReturnValue({
      ...initial,
      bootstrapConfig: { gateway: { controlUi: { experimental: { claws: enabled } } } },
    });
    expect(readShellView(owner).sidebarProperties.enabledRouteIds.includes("claws")).toBe(enabled);
    expect(readShellView(owner).sidebarProperties.enabledRouteIds).toContain("agents");
  }
});

it("updates native history buttons only while connected and refreshes them on reconnect", async () => {
  Object.assign(window, {
    __OPENCLAW_NATIVE_WEB_CHROME__: true,
    __OPENCLAW_NATIVE_HISTORY__: { canGoBack: false, canGoForward: true },
  });
  onTestFinished(() => {
    Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
    Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_HISTORY__");
  });
  const { owner, query } = await mountShell();
  owner.connect();
  // This view fixture leaves the router stopped; restore its selected route after connection.
  owner.routeState = { routeId: "chat" };
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expect(query<HTMLButtonElement>(".macos-titlebar-controls__back")?.disabled).toBe(true);
    expect(query<HTMLButtonElement>(".macos-titlebar-controls__forward")?.disabled).toBe(false);
  });
  const back = query<HTMLButtonElement>(".macos-titlebar-controls__back")!;
  const forward = query<HTMLButtonElement>(".macos-titlebar-controls__forward")!;
  const publish = (canGoBack: boolean, canGoForward: boolean) =>
    window.dispatchEvent(
      new CustomEvent(NATIVE_HISTORY_STATE_EVENT, { detail: { canGoBack, canGoForward } }),
    );

  publish(true, false);
  await waitForSolid(() => {
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);
  });
  owner.disconnect();
  publish(false, true);
  flush();
  expect(back.disabled).toBe(false);
  expect(forward.disabled).toBe(true);

  owner.connect();
  owner.routeState = { routeId: "chat" };
  await waitForSolid(() => {
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(false);
  });
  publish(true, false);
  await waitForSolid(() => {
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);
  });
});

it("passes the assistant a live lookup of the selected registered chat pane", async () => {
  const { owner, query } = await mountShell();
  const panel = query("openclaw-assistant-panel")!;
  const outlet = owner.routeOutlet!;
  const pane = Object.assign(document.createElement("openclaw-chat-pane"), {
    sessionKey: "agent:main:main",
    presented: true,
  });
  pane.classList.add("chat-pane-cache__pane--active");
  outlet.append(pane);
  const unregister = registerRouteElement(pane);
  onTestFinished(() => unregister?.());

  expect(panel.getPrimaryChatPane?.("main")).toBe(pane);
  for (const sessionKey of ["", "agent:other:main"]) {
    expect(panel.getPrimaryChatPane?.(sessionKey)).toBeUndefined();
  }
  pane.presented = false;
  expect(panel.getPrimaryChatPane?.("main")).toBeUndefined();
  pane.presented = true;
  pane.classList.remove("chat-pane-cache__pane--active");
  expect(panel.getPrimaryChatPane?.("main")).toBeUndefined();
  pane.classList.add("chat-pane-cache__pane--active");
  expect(panel.getPrimaryChatPane?.("main")).toBe(pane);
  pane.remove();
  expect(panel.getPrimaryChatPane?.("main")).toBeUndefined();
});

it("reserves session geometry before page mount and clears it on other routes", async () => {
  const { owner, query, refresh } = await mountShell();
  const content = query("main.content")!;
  expect(content.classList.contains("content--workbench")).toBe(true);
  expect(content.querySelector("openclaw-chat-pane")).toBeNull();
  for (const routeId of [
    "new-session",
    "systems",
    "dashboard",
    "connection",
    undefined,
    "chat",
  ] as const) {
    owner.routeState = { routeId, routeFailed: routeId === undefined };
    refresh();
    expect(content.classList.contains("content--workbench"), String(routeId)).toBe(
      routeId === "chat" || routeId === "dashboard",
    );
  }
  owner.routeState = { routeId: "chat", routeFailed: true };
  refresh();
  expect(content.classList.contains("content--workbench")).toBe(false);
});

it("preserves notice padding when a session route resolves without a chat pane", async () => {
  const { owner, query } = await mountShell();
  const content = query("main.content")!;
  const router = createRouter<"chat", ChatRouteData, unknown, ChatRouteData>({
    routes: [
      definePage({ id: "chat", path: "/chat", component: () => ({}), loader: (data) => data }),
    ],
  });
  const unsubscribe = router.subscribeSelector(
    selectShellRouteState,
    (state) => {
      owner.routeState = state;
      owner.invalidate();
    },
    equalShellRouteState,
  );
  onTestFinished(() => {
    unsubscribe();
    router.stop();
  });
  const session = { kind: "session", sessionKey: "agent:main:main", face: "chat" } as const;
  await router.navigate("chat", session);
  const notices: ChatRouteData[] = [
    { kind: "ambiguous", shortId: "abc123", candidates: [], truncated: false, face: "chat" },
    { kind: "route-error", message: "Session unavailable", face: "chat" },
    {
      kind: "missing-session",
      face: "chat",
      currentSessionHref: "/chat",
      sessionsHref: "/sessions",
    },
  ];
  for (const notice of notices) {
    await router.revalidate(notice);
    flush();
    expect(content.classList.contains("content--workbench"), notice.kind).toBe(false);
    await router.revalidate(session);
    flush();
    expect(content.classList.contains("content--workbench")).toBe(true);
  }
});

it("keeps pages interactive through transport loss and fences reload-required", async () => {
  const { owner, runtime, query, refresh } = await mountShell();
  owner.routeState = { routeId: "logs" };
  const snapshot = vi.spyOn(runtime.context.gateway, "snapshot", "get");
  const initial = runtime.context.gateway.snapshot;
  for (const phase of ["reconnecting", "offline", "reload-required"] as const) {
    snapshot.mockReturnValue({ ...initial, phase });
    refresh();
    expect(query("#control-ui-main")?.hasAttribute("inert"), phase).toBe(false);
    const outlet = query("openclaw-router-outlet")!;
    expect(outlet.hasAttribute("inert"), phase).toBe(phase === "reload-required");
    expect(outlet.getAttribute("aria-disabled"), phase).toBe(
      phase === "reload-required" ? "true" : null,
    );
    expect(query(".connection-action-block"), phase).toBeNull();
  }
});

it("keeps one sidebar through drawer and settings takeover transitions", async () => {
  let mobile = false;
  mockMobile(() => mobile);
  const { owner, view, query, refresh } = await mountShell();
  const sidebar = query("openclaw-app-sidebar");
  const outlet = query("openclaw-router-outlet");
  expect(sidebar).toBe(owner.navigationSidebar);
  expect(outlet).not.toBeNull();

  mobile = true;
  owner.navDrawerOpen = true;
  refresh();
  const drawer = query(".shell-nav");
  expect(drawer?.getAttribute("role")).toBe("dialog");
  expect(drawer?.getAttribute("aria-modal")).toBe("true");
  expect(drawer?.contains(sidebar)).toBe(true);
  expect(query("#control-ui-main")?.hasAttribute("inert")).toBe(true);
  expect(query("openclaw-router-outlet")).toBe(outlet);

  owner.navDrawerOpen = false;
  flush();
  expect(drawer?.getAttribute("aria-hidden")).toBe("true");
  expect(query("#control-ui-main")?.hasAttribute("inert")).toBe(false);
  expect(query("openclaw-app-sidebar")).toBe(sidebar);

  mobile = false;
  refresh();
  expect(drawer?.hasAttribute("role")).toBe(false);
  expect(view.container.querySelectorAll("openclaw-app-sidebar")).toHaveLength(1);
  expect(query("openclaw-app-sidebar")).toBe(sidebar);
  expect(query("openclaw-router-outlet")).toBe(outlet);

  owner.routeState = { routeId: "appearance" };
  refresh();
  expect(query("openclaw-app-sidebar")).toBeNull();
  expect(owner.navigationSidebar).toBe(sidebar);

  owner.routeState = { routeId: "chat" };
  refresh();
  await vi.dynamicImportSettled();
  flush();
  expect(query("openclaw-app-sidebar")).toBe(sidebar);
  expect(view.container.querySelectorAll("openclaw-app-sidebar")).toHaveLength(1);
  expect(query("openclaw-router-outlet")).toBe(outlet);
});

it("keeps the mobile New Session action live across selection and access changes", async () => {
  mockMobile(() => true);
  const { owner, runtime, query, refresh } = await mountShell();
  owner.routeState = { routeId: "sessions" };
  const context = runtime.context;
  vi.spyOn(context.theme, "settings", "get").mockReturnValue({
    ...context.theme.settings,
    sidebarAgentsMode: "chip",
  });
  const connected = {
    ...context.gateway.snapshot,
    phase: "connected" as const,
    client: new GatewayBrowserClient({ url: "ws://gateway.example.test" }),
    hello: {
      type: "hello-ok" as const,
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.sessions.write"] },
      features: { methods: ["sessions.create"] },
    },
  };
  const snapshot = vi.spyOn(context.gateway, "snapshot", "get").mockReturnValue(connected);
  const selection = vi.spyOn(context.agentSelection, "state", "get");
  selection.mockReturnValue({ ...context.agentSelection.state, selectedId: "writer" });
  const navigate = vi.spyOn(context, "navigate").mockImplementation(() => undefined);
  refresh();
  const topbar = query<SolidBridgeElement<object>>("openclaw-app-topbar")!;
  await topbar.updateComplete;
  const action = query<HTMLAnchorElement>(".header-new-session")!;
  expect(action.getAttribute("href")).toBe("/new?agent=writer");
  action.focus();

  selection.mockReturnValue({ ...context.agentSelection.state, selectedId: "reviewer" });
  refresh();
  await topbar.updateComplete;
  expect(query(".header-new-session")).toBe(action);
  expect(document.activeElement).toBe(action);
  expect(action.getAttribute("href")).toBe("/new?agent=reviewer");
  action.click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("new-session", { search: "?agent=reviewer" });
  navigate.mockClear();

  // The synchronous permission owner wins even before the next render commits.
  snapshot.mockReturnValue({ ...connected, phase: "stopped" });
  action.click();
  expect(navigate).not.toHaveBeenCalled();
  refresh();
  await topbar.updateComplete;
  expect(action.hasAttribute("href")).toBe(false);
  expect(action.getAttribute("aria-disabled")).toBe("true");

  snapshot.mockReturnValue(connected);
  refresh();
  await topbar.updateComplete;
  expect(query(".header-new-session")).toBe(action);
  expect(action.getAttribute("href")).toBe("/new?agent=reviewer");
  expect(action.hasAttribute("aria-disabled")).toBe(false);
});

it("clears navigation resize feedback when the drag ends or its divider disconnects", async () => {
  const { query } = await mountShell();
  const shell = query(".shell")!;
  const divider = query<HTMLElementTagNameMap["resizable-divider"]>(".sidebar-resizer")!;
  divider.measureSize = () => 1000;
  await divider.updateComplete;
  // The separator keeps its accessible name without a hover tooltip over the drag handle.
  expect(divider.getAttribute("aria-label")).toBe("Resize sidebar");
  expect(divider.hasAttribute("title")).toBe(false);
  const start = () =>
    divider.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, pointerId: 7, bubbles: true }),
    );

  start();
  flush();
  expect(shell.classList.contains("shell--nav-resizing")).toBe(true);
  window.dispatchEvent(new Event("blur"));
  flush();
  expect(shell.classList.contains("shell--nav-resizing")).toBe(false);

  start();
  flush();
  expect(shell.classList.contains("shell--nav-resizing")).toBe(true);
  divider.remove();
  // The bridge retains a root through same-turn relocation, then ends the drag.
  await Promise.resolve();
  flush();
  expect(shell.classList.contains("shell--nav-resizing")).toBe(false);
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
  flush();
  expect(shell.classList.contains("shell--nav-resizing")).toBe(false);
});

it.each([false, true])(
  "keeps the focused gateway retry across footer and mobile header updates (mobile %s)",
  async (mobile) => {
    mockMobile(() => mobile);
    const { owner, runtime, query, refresh } = await mountShell();
    owner.routeState = { routeId: "sessions" };
    await vi.dynamicImportSettled();
    const presentation = () =>
      query(mobile ? ".mobile-connection-status" : ".sidebar-shell__footer")!;
    const settle = async () => {
      refresh();
      await owner.navigationSidebar.updateComplete;
      await query<SolidBridgeElement<object>>("openclaw-app-topbar")!.updateComplete;
      flush();
    };
    const disconnected = {
      ...runtime.context.gateway.snapshot,
      phase: "offline" as const,
      offlineStable: true,
      lastError: "Gateway unavailable",
    };
    const snapshot = vi.spyOn(runtime.context.gateway, "snapshot", "get");
    snapshot.mockReturnValue(disconnected);
    await settle();

    const retry = presentation().querySelector<HTMLButtonElement>("button")!;
    expect(retry.getAttribute("aria-label")).toBe("Disconnected — Retry now");
    retry.focus();
    expect(document.activeElement).toBe(retry);

    snapshot.mockReturnValue({
      ...disconnected,
      lastError: "Connection refused?token=chip-secret",
    });
    await settle();

    expect(presentation().querySelector("button")).toBe(retry);
    expect(document.activeElement).toBe(retry);
    const tooltip =
      presentation().querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>("openclaw-tooltip");
    expect(tooltip?.content).toBe("Connection refused?[redacted-credential]");

    let queuedCount = 2;
    owner.outboxStoreRuntime = {
      read: () => ({
        total: queuedCount,
        sessions: [],
        attentionCountForSession: () => 0,
        hasSessionDraft: () => false,
      }),
      subscribe: () => () => {},
      invalidate: () => {},
    };
    snapshot.mockReturnValue({ ...disconnected, deferredIntentCount: 1 });
    await settle();
    expect(presentation().querySelector("button")).toBe(retry);
    expect(retry.getAttribute("aria-label")).toBe("Disconnected · 3 queued — Retry now");
    expect(query(".shell > .sr-only[role=status]")?.textContent).toBe("Disconnected · 3 queued");
    expect(document.activeElement).toBe(retry);
    queuedCount = 1;
    await settle();
    expect(presentation().querySelector("button")).toBe(retry);
    expect(retry.getAttribute("aria-label")).toBe("Disconnected · 2 queued — Retry now");
    queuedCount = 0;
    await settle();
    expect(retry.getAttribute("aria-label")).toBe("Disconnected · 1 queued — Retry now");

    snapshot.mockReturnValue({ ...disconnected, phase: "connecting" });
    await settle();
    expect(presentation().textContent).toContain("Connecting…");
    expect(presentation().querySelector("button")).toBeNull();
  },
);

it("keeps one connection announcement through outage and recovery with the mobile drawer closed", async () => {
  mockMobile(() => true);
  const { owner, runtime, query, refresh } = await mountShell();
  owner.routeState = { routeId: "sessions" };
  const connected = {
    ...runtime.context.gateway.snapshot,
    phase: "connected" as const,
    offlineStable: false,
  };
  const snapshot = vi.spyOn(runtime.context.gateway, "snapshot", "get").mockReturnValue(connected);
  refresh();

  const announcement = query(".shell > .sr-only[role=status]")!;
  expect(announcement).not.toBeNull();
  expect(announcement.textContent).toBe("Connected");
  expect(announcement.getAttribute("aria-live")).toBe("polite");
  expect(announcement.getAttribute("aria-atomic")).toBe("true");
  expect(query(".shell-nav")?.hasAttribute("inert")).toBe(true);
  expect(announcement.closest("[inert]")).toBeNull();

  snapshot.mockReturnValue({ ...connected, phase: "offline", offlineStable: true });
  refresh();
  expect(query(".shell > .sr-only[role=status]")).toBe(announcement);
  expect(announcement.textContent).toBe("Disconnected");
  await query<SolidBridgeElement<object>>("openclaw-app-topbar")!.updateComplete;
  const line = query(".mobile-connection-status")!;
  expect(line.textContent).toContain("Disconnected");
  expect(line.querySelector("[role=status], [aria-live]")).toBeNull();

  snapshot.mockReturnValue(connected);
  refresh();
  expect(query(".shell > .sr-only[role=status]")).toBe(announcement);
  expect(announcement.textContent).toBe("Connected");
  await query<SolidBridgeElement<object>>("openclaw-app-topbar")!.updateComplete;
  expect(query(".mobile-connection-status")).toBeNull();
});

it("keeps status in navigation across web layouts without replacing the content frame", async () => {
  let mobile = false;
  mockMobile(() => mobile);
  const { owner, runtime, query, refresh } = await mountShell();
  await vi.dynamicImportSettled();
  const snapshot = vi.spyOn(runtime.context.gateway, "snapshot", "get");
  const initial = runtime.context.gateway.snapshot;
  const content = query("main.content");
  const footer = () => query(".sidebar-shell__footer .gateway-status");
  for (const phase of ["connecting", "starting", "connected", "offline"] as const) {
    snapshot.mockReturnValue({ ...initial, phase, offlineStable: false });
    refresh();
    await owner.navigationSidebar.updateComplete;
    expect(footer(), phase).toBeNull();
  }
  snapshot.mockReturnValue({ ...initial, phase: "offline", offlineStable: true });
  for (const layout of [
    { mobile: false, collapsed: false, drawer: false, routeId: "chat" },
    { mobile: false, collapsed: true, drawer: false, routeId: "chat" },
    { mobile: false, collapsed: false, drawer: false, routeId: "appearance" },
    { mobile: true, collapsed: false, drawer: false, routeId: "sessions" },
    { mobile: true, collapsed: false, drawer: true, routeId: "chat" },
    { mobile: true, collapsed: false, drawer: true, routeId: "appearance" },
  ] as const) {
    mobile = layout.mobile;
    runtime.context.navigation.update({ navCollapsed: layout.collapsed });
    owner.navDrawerOpen = layout.drawer;
    owner.routeState = { routeId: layout.routeId };
    refresh();
    await vi.dynamicImportSettled();
    await owner.navigationSidebar.updateComplete;
    flush();
    expect(footer()?.textContent, JSON.stringify(layout)).toContain("Disconnected");
    expect(query(".mobile-connection-status") !== null).toBe(layout.mobile && !layout.drawer);
    expect(footer()?.querySelector("[role=status], [aria-live]")).toBeNull();
    expect(query("main.content")).toBe(content);
  }

  vi.stubGlobal("__OPENCLAW_NATIVE_EMBED__", { platform: "ios", formFactor: "phone" });
  refresh();
  expect(footer()).toBeNull();
  expect(query(".mobile-connection-status, .sidebar-connection-flag")).toBeNull();
});

it("keeps connection retry in the minimal footer when the Settings renderer is unavailable", async () => {
  const { owner, runtime, view, query, refresh } = await mountShell();
  const renderer = vi.spyOn(settingsSidebar, "ShellSettingsSidebar").mockImplementation(() => {
    throw new Error("Settings chunk unavailable");
  });
  onTestFinished(() => renderer.mockRestore());
  vi.spyOn(runtime.context.gateway, "snapshot", "get").mockReturnValue({
    ...runtime.context.gateway.snapshot,
    phase: "offline",
    offlineStable: true,
  });
  const connect = vi.spyOn(runtime.context.gateway, "connect").mockImplementation(() => undefined);
  owner.routeState = { routeId: "appearance" };
  refresh();
  await vi.dynamicImportSettled();
  flush();

  expect(query(".shell--settings")).not.toBeNull();
  const footer = query(".shell-nav > .sidebar .sidebar-shell__footer");
  expect(footer?.textContent).toContain("Disconnected");
  const retry = view.getByRole("button", { name: "Disconnected — Retry now" });
  expect(footer?.contains(retry)).toBe(true);
  expect(retry.closest("[inert], [hidden]")).toBeNull();
  retry.focus();
  expect(document.activeElement).toBe(retry);
  retry.click();
  expect(connect).toHaveBeenCalledOnce();
});

it("briefly reveals collapsed status transitions and a recovery footer without extending their timers", async () => {
  vi.stubGlobal("innerWidth", 1280);
  const { owner, runtime, query, refresh } = await mountShell();
  await vi.dynamicImportSettled();
  await owner.navigationSidebar.updateComplete;
  vi.useFakeTimers();
  const connected = {
    ...runtime.context.gateway.snapshot,
    phase: "connected" as const,
    offlineStable: false,
  };
  const snapshot = vi.spyOn(runtime.context.gateway, "snapshot", "get").mockReturnValue(connected);
  runtime.context.navigation.update({ navCollapsed: true });
  const settle = async () => {
    refresh();
    await owner.navigationSidebar.updateComplete;
    flush();
  };
  const flag = () => query(".sidebar-connection-flag");
  const footer = () => query(".sidebar-shell__footer .gateway-status");
  await settle();
  expect(flag()?.hasAttribute("data-open")).toBe(false);
  expect(footer()).toBeNull();
  snapshot.mockReturnValue({ ...connected, phase: "offline", offlineStable: true });
  await settle();
  expect(flag()?.hasAttribute("data-open")).toBe(true);
  expect(flag()?.textContent).toContain("Disconnected");
  vi.advanceTimersByTime(3_000);
  snapshot.mockReturnValue({
    ...connected,
    phase: "offline",
    offlineStable: true,
    lastError: "Still unavailable",
  });
  await settle();
  vi.advanceTimersByTime(1_000);
  await settle();
  expect(flag()?.hasAttribute("data-open")).toBe(false);
  snapshot.mockReturnValue({ ...connected, phase: "reconnecting", offlineStable: true });
  await settle();
  expect(flag()?.hasAttribute("data-open")).toBe(true);
  expect(flag()?.textContent).toContain("Reconnecting…");
  snapshot.mockReturnValue(connected);
  await settle();
  expect(flag()?.hasAttribute("data-open")).toBe(true);
  expect(footer()?.textContent).toBe("Connected");
  vi.advanceTimersByTime(2_000);
  await settle();
  expect(footer()).toBeNull();
  expect(flag()?.hasAttribute("data-open")).toBe(true);
  vi.advanceTimersByTime(2_000);
  await settle();
  expect(flag()?.hasAttribute("data-open")).toBe(false);
});

it("checks writing-surface clearance only when the avatar flag would open", async () => {
  const { owner, runtime, query, refresh } = await mountShell();
  await vi.dynamicImportSettled();
  const connected = { ...runtime.context.gateway.snapshot, phase: "connected" as const };
  const snapshot = vi.spyOn(runtime.context.gateway, "snapshot", "get").mockReturnValue(connected);
  runtime.context.navigation.update({ navCollapsed: true });
  const settle = async () => {
    refresh();
    await owner.navigationSidebar.updateComplete;
    flush();
  };
  await settle();
  const anchor = query<HTMLElement>(".sidebar-identity-anchor")!;
  const card = anchor.querySelector<HTMLButtonElement>(".sidebar-identity-card")!;
  const flag = anchor.querySelector<HTMLElement>(".sidebar-connection-flag")!;
  const measure = vi
    .spyOn(anchor, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(8, 764, 36, 36));
  vi.spyOn(flag, "getBoundingClientRect").mockReturnValue(new DOMRect(36, 756, 240, 44));
  const footer = document.createElement("div");
  footer.className = "chat-footer";
  const composer = document.createElement("div");
  composer.className = "agent-chat__composer-shell";
  let visible = true;
  composer.checkVisibility = () => visible;
  let bounds = new DOMRect(60, 760, 600, 80);
  vi.spyOn(composer, "getBoundingClientRect").mockImplementation(() => bounds);
  footer.append(composer);
  query("main.content")!.append(footer);
  owner.shellLayout.registerFooterControlSurface(composer);
  vi.useFakeTimers();
  snapshot.mockReturnValue({ ...connected, phase: "offline", offlineStable: true });
  await settle();
  expect(flag.hasAttribute("data-open")).toBe(false);
  expect(card.title).toBe(card.getAttribute("aria-label"));
  expect(measure).toHaveBeenCalledOnce();
  snapshot.mockReturnValue({
    ...connected,
    phase: "offline",
    offlineStable: true,
    lastError: "Still offline",
  });
  await settle();
  expect(measure).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(4_000);
  await settle();

  anchor.dispatchEvent(new Event("pointerenter"));
  flush();
  expect(flag.hasAttribute("data-open")).toBe(false);
  expect(card.title).toBe(card.getAttribute("aria-label"));
  anchor.dispatchEvent(new Event("pointerleave"));
  flush();
  visible = false;
  anchor.dispatchEvent(new Event("pointerenter"));
  flush();
  expect(flag.hasAttribute("data-open")).toBe(true);
  expect(card.title).toBe("");
  expect(card.getAttribute("aria-label")).toContain("Disconnected");
  anchor.dispatchEvent(new Event("pointerleave"));
  flush();
  visible = true;
  bounds = new DOMRect(500, 760, 600, 80);
  card.focus();
  flush();
  expect(flag.hasAttribute("data-open")).toBe(true);
  const reads = measure.mock.calls.length;
  bounds = new DOMRect(60, 760, 600, 80);
  await settle();
  expect(measure).toHaveBeenCalledTimes(reads);
  card.blur();
  flush();
  card.focus();
  flush();
  expect(flag.hasAttribute("data-open")).toBe(false);
  expect(card.title).toBe(card.getAttribute("aria-label"));
});

it("restores the delegated shell after a pending update and can select another workspace", async () => {
  const { owner, runtime, view, query, refresh } = await mountShell();
  const shell = query(".shell");
  const sidebar = query("openclaw-app-sidebar");
  const expectShell = () => {
    expect(query(".shell")).toBe(shell);
    expect(query("openclaw-app-sidebar")).toBe(sidebar);
  };
  const expectBuiltIn = () => {
    expect(query("openclaw-plugin-view")).toBeNull();
    expectShell();
  };
  const selectWorkspace = (value?: ControlUiRegistration<ControlUiReplacement>) => {
    selected.mockImplementation((surface) => (surface === "workspace" ? value : undefined));
    runtime.context.plugins.selectReplacement("workspace", null);
    refresh();
  };
  const abort = new AbortController();
  // This fixture delegates the built-in view without calling plugin services.
  const host = {
    signal: abort.signal,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
  const replacement: ControlUiRegistration<ControlUiReplacement> = {
    key: "fixture/workspace",
    pluginId: "fixture",
    signal: abort.signal,
    host,
    value: {
      id: "workspace",
      label: "Workspace fixture",
      surface: "workspace",
      mount(container, context) {
        container.dataset.delegatedWorkspace = "";
        return { dispose: context.mountDefault(container) };
      },
    },
  };
  const selected = vi.spyOn(runtime.context.plugins, "selectedReplacement");
  selected.mockReturnValue(undefined);
  runtime.context.plugins.selectReplacement("workspace", null);
  owner.routeState = { routeId: "plugins" };
  refresh();
  selectWorkspace(replacement);
  expectBuiltIn();

  owner.routeState = { routeId: "dashboard" };
  refresh();
  let plugin = query<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view");
  expect(plugin).not.toBeNull();
  await settleLitElement(plugin!);
  const target = query("[data-delegated-workspace]");
  expect(target?.querySelector(".shell")).toBe(shell);
  expect(target?.querySelector("openclaw-app-sidebar")).toBe(sidebar);

  // A pending plugin update cannot remove the shell restored directly on Dashboard.
  plugin!.props = { sessionKey: "agent:main:updated", routeId: "dashboard" };
  selectWorkspace();
  expectBuiltIn();
  await settleLitElement(plugin!);
  expectShell();
  expect(shell?.isConnected).toBe(true);

  selectWorkspace(replacement);
  plugin = query<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view");
  expect(plugin).not.toBeNull();
  await settleLitElement(plugin!);
  expect(plugin!.querySelector(".shell")).toBe(shell);

  // Plugins restores the built-in shell while the delegated workspace remains selected.
  plugin!.props = { sessionKey: "agent:main:updated", routeId: "dashboard" };
  owner.routeState = { routeId: "plugins" };
  refresh();
  expectBuiltIn();

  await settleLitElement(plugin!);
  expectShell();
  expect(shell?.isConnected).toBe(true);

  selectWorkspace();
  owner.routeState = { routeId: "dashboard" };
  refresh();
  expectBuiltIn();

  const customWorkspace: ControlUiRegistration<ControlUiReplacement> = {
    ...replacement,
    key: "fixture/custom-workspace",
    value: {
      id: "custom-workspace",
      label: "Custom workspace",
      surface: "workspace",
      mount(container) {
        const heading = document.createElement("h1");
        heading.textContent = "Custom workspace";
        container.append(heading);
      },
    },
  };
  owner.routeState = { routeId: "plugins" };
  refresh();
  selectWorkspace(customWorkspace);
  expect(query("openclaw-plugin-view")).toBeNull();
  expect(query(".shell")).toBe(shell);

  owner.routeState = { routeId: "dashboard" };
  refresh();
  const customPlugin = query<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view");
  expect(customPlugin).not.toBeNull();
  await settleLitElement(customPlugin!);
  expect(view.getByRole("heading", { name: "Custom workspace" })).toBeTruthy();

  owner.routeState = { routeId: "plugins" };
  refresh();
  await settleLitElement(customPlugin!);
  expectBuiltIn();

  selectWorkspace();
  owner.routeState = { routeId: "dashboard" };
  refresh();
  expectShell();
  expect(shell?.isConnected).toBe(true);
});

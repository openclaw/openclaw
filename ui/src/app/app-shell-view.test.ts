/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { render } from "@solidjs/testing-library";
import { createComponent, createRoot, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiHost, ControlUiReplacement } from "../../../src/plugin-sdk/control-ui.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import type { SolidBridgeElement } from "../lit/solid-bridge.ts";
import "../plugins/control-ui-view.solid.tsx";
import type { ChatRouteData } from "../pages/chat/session-route-data.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { equalShellRouteState, selectShellRouteState } from "./app-host-route-state.ts";
import { ShellOwner } from "./app-host.tsx";
import { renderApplicationShell } from "./app-shell-view.tsx";
import { bootstrapApplication } from "./bootstrap.ts";

setupSidebarTest();

async function mountShell() {
  const runtime = bootstrapApplication();
  const { owner, dispose } = createRoot((disposeRoot) => ({
    owner: new ShellOwner(document.createElement("openclaw-app-shell"), runtime),
    dispose: disposeRoot,
  }));
  owner.routeState = { routeId: "chat" };
  document.body.append(owner.element);
  const view = render(
    () =>
      createComponent(ApplicationProvider, {
        host: owner.element,
        value: runtime.context,
        get children() {
          return renderApplicationShell(owner);
        },
      }),
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
  flush();
  return { owner, runtime, view };
}

it("reserves session geometry before page mount and clears it on other routes", async () => {
  const { owner, view } = await mountShell();
  const content = view.container.querySelector("main.content")!;
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
    owner.invalidate();
    flush();
    expect(content.classList.contains("content--workbench"), String(routeId)).toBe(
      routeId === "chat" || routeId === "dashboard",
    );
  }
  owner.routeState = { routeId: "chat", routeFailed: true };
  owner.invalidate();
  flush();
  expect(content.classList.contains("content--workbench")).toBe(false);
});

it("preserves notice padding when a session route resolves without a chat pane", async () => {
  const { owner, view } = await mountShell();
  const content = view.container.querySelector("main.content")!;
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

it("keeps one sidebar and outlet while navigation moves between desktop and drawer", async () => {
  let mobile = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: mobile })),
  );
  const { owner, view } = await mountShell();
  const sidebar = view.container.querySelector("openclaw-app-sidebar");
  const outlet = view.container.querySelector("openclaw-router-outlet");
  expect(sidebar).toBe(owner.navigationSidebar);
  expect(outlet).not.toBeNull();

  mobile = true;
  owner.navDrawerOpen = true;
  owner.invalidate();
  flush();
  const drawer = view.container.querySelector(".shell-nav");
  expect(drawer?.getAttribute("role")).toBe("dialog");
  expect(drawer?.getAttribute("aria-modal")).toBe("true");
  expect(drawer?.contains(sidebar)).toBe(true);
  expect(view.container.querySelector("openclaw-router-outlet")).toBe(outlet);

  owner.navDrawerOpen = false;
  flush();
  expect(drawer?.getAttribute("aria-hidden")).toBe("true");
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);

  mobile = false;
  owner.invalidate();
  flush();
  expect(drawer?.hasAttribute("role")).toBe(false);
  expect(view.container.querySelectorAll("openclaw-app-sidebar")).toHaveLength(1);
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);
  expect(view.container.querySelector("openclaw-router-outlet")).toBe(outlet);
});

it("keeps the mobile New Session action live across selection and access changes", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  const { owner, runtime, view } = await mountShell();
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
  owner.invalidate();
  flush();
  const topbar = view.container.querySelector<SolidBridgeElement<object>>("openclaw-app-topbar")!;
  await topbar.updateComplete;
  const action = view.container.querySelector<HTMLAnchorElement>(".header-new-session")!;
  expect(action.getAttribute("href")).toBe("/new?agent=writer");
  action.focus();

  selection.mockReturnValue({ ...context.agentSelection.state, selectedId: "reviewer" });
  owner.invalidate();
  flush();
  await topbar.updateComplete;
  expect(view.container.querySelector(".header-new-session")).toBe(action);
  expect(document.activeElement).toBe(action);
  expect(action.getAttribute("href")).toBe("/new?agent=reviewer");
  action.click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("new-session", { search: "?agent=reviewer" });
  navigate.mockClear();

  // The synchronous permission owner wins even before the next render commits.
  snapshot.mockReturnValue({ ...connected, phase: "stopped" });
  action.click();
  expect(navigate).not.toHaveBeenCalled();
  owner.invalidate();
  flush();
  await topbar.updateComplete;
  expect(action.hasAttribute("href")).toBe(false);
  expect(action.getAttribute("aria-disabled")).toBe("true");

  snapshot.mockReturnValue(connected);
  owner.invalidate();
  flush();
  await topbar.updateComplete;
  expect(view.container.querySelector(".header-new-session")).toBe(action);
  expect(action.getAttribute("href")).toBe("/new?agent=reviewer");
  expect(action.hasAttribute("aria-disabled")).toBe(false);
});

it("keeps the focused gateway retry button across shell and error updates", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  const { owner, runtime, view } = await mountShell();
  const disconnected = {
    ...runtime.context.gateway.snapshot,
    phase: "offline" as const,
    offlineStable: true,
    lastError: "Gateway unavailable",
  };
  const snapshot = vi.spyOn(runtime.context.gateway, "snapshot", "get");
  snapshot.mockReturnValue(disconnected);
  owner.invalidate();
  flush();

  const retry = view.getByRole("button", { name: "Disconnected — Retry now" });
  retry.focus();
  expect(document.activeElement).toBe(retry);

  snapshot.mockReturnValue({ ...disconnected, lastError: "Connection refused" });
  owner.navResizing = true;
  owner.invalidate();
  flush();

  expect(view.getByRole("button", { name: "Disconnected — Retry now" })).toBe(retry);
  expect(document.activeElement).toBe(retry);
  const tooltip = view.container.querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>(
    ".shell-connection-status openclaw-tooltip",
  );
  expect(tooltip?.content).toBe("Connection refused");

  snapshot.mockReturnValue({ ...disconnected, phase: "connecting" });
  owner.invalidate();
  flush();
  expect(view.container.querySelector(".shell-connection-status")?.textContent).toContain(
    "Connecting…",
  );
  expect(view.queryByRole("button", { name: "Disconnected — Retry now" })).toBeNull();
});

it("restores the delegated shell after a pending update and can select another workspace", async () => {
  const { runtime, owner, view } = await mountShell();
  const shell = view.container.querySelector(".shell");
  const sidebar = view.container.querySelector("openclaw-app-sidebar");
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
  owner.invalidate();
  flush();
  selected.mockImplementation((surface) => (surface === "workspace" ? replacement : undefined));
  runtime.context.plugins.selectReplacement("workspace", null);
  owner.invalidate();
  flush();
  expect(view.container.querySelector("openclaw-plugin-view")).toBeNull();
  expect(view.container.querySelector(".shell")).toBe(shell);
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);

  owner.routeState = { routeId: "dashboard" };
  owner.invalidate();
  flush();
  let plugin =
    view.container.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>(
      "openclaw-plugin-view",
    );
  expect(plugin).not.toBeNull();
  await settleLitElement(plugin!);
  const target = view.container.querySelector("[data-delegated-workspace]");
  expect(target?.querySelector(".shell")).toBe(shell);
  expect(target?.querySelector("openclaw-app-sidebar")).toBe(sidebar);

  // A pending plugin update cannot remove the shell restored directly on Dashboard.
  plugin!.props = { sessionKey: "agent:main:updated", routeId: "dashboard" };
  selected.mockReturnValue(undefined);
  runtime.context.plugins.selectReplacement("workspace", null);
  owner.invalidate();
  flush();
  expect(view.container.querySelector("openclaw-plugin-view")).toBeNull();
  expect(view.container.querySelector(".shell")).toBe(shell);
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);
  await settleLitElement(plugin!);
  expect(view.container.querySelector(".shell")).toBe(shell);
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);
  expect(shell?.isConnected).toBe(true);

  selected.mockImplementation((surface) => (surface === "workspace" ? replacement : undefined));
  runtime.context.plugins.selectReplacement("workspace", null);
  owner.invalidate();
  flush();
  plugin =
    view.container.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>(
      "openclaw-plugin-view",
    );
  expect(plugin).not.toBeNull();
  await settleLitElement(plugin!);
  expect(plugin!.querySelector(".shell")).toBe(shell);

  // Plugins restores the built-in shell while the delegated workspace remains selected.
  plugin!.props = { sessionKey: "agent:main:updated", routeId: "dashboard" };
  owner.routeState = { routeId: "plugins" };
  owner.invalidate();
  flush();
  expect(view.container.querySelector("openclaw-plugin-view")).toBeNull();
  expect(view.container.querySelector(".shell")).toBe(shell);
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);

  await settleLitElement(plugin!);
  expect(view.container.querySelector(".shell")).toBe(shell);
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);
  expect(shell?.isConnected).toBe(true);

  selected.mockReturnValue(undefined);
  runtime.context.plugins.selectReplacement("workspace", null);
  owner.invalidate();
  flush();
  owner.routeState = { routeId: "dashboard" };
  owner.invalidate();
  flush();
  expect(view.container.querySelector("openclaw-plugin-view")).toBeNull();
  expect(view.container.querySelector(".shell")).toBe(shell);
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);

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
  owner.invalidate();
  flush();
  selected.mockImplementation((surface) => (surface === "workspace" ? customWorkspace : undefined));
  runtime.context.plugins.selectReplacement("workspace", null);
  owner.invalidate();
  flush();
  expect(view.container.querySelector("openclaw-plugin-view")).toBeNull();
  expect(view.container.querySelector(".shell")).toBe(shell);

  owner.routeState = { routeId: "dashboard" };
  owner.invalidate();
  flush();
  const customPlugin =
    view.container.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>(
      "openclaw-plugin-view",
    );
  expect(customPlugin).not.toBeNull();
  await settleLitElement(customPlugin!);
  expect(view.getByRole("heading", { name: "Custom workspace" })).toBeTruthy();

  owner.routeState = { routeId: "plugins" };
  owner.invalidate();
  flush();
  await settleLitElement(customPlugin!);
  expect(view.container.querySelector("openclaw-plugin-view")).toBeNull();
  expect(view.container.querySelector(".shell")).toBe(shell);
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);

  selected.mockReturnValue(undefined);
  runtime.context.plugins.selectReplacement("workspace", null);
  owner.invalidate();
  flush();
  owner.routeState = { routeId: "dashboard" };
  owner.invalidate();
  flush();
  expect(view.container.querySelector(".shell")).toBe(shell);
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);
  expect(shell?.isConnected).toBe(true);
});

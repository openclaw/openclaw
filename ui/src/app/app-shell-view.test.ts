/* @vitest-environment jsdom */

import { render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiHost, ControlUiReplacement } from "../../../src/plugin-sdk/control-ui.js";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import "../plugins/control-ui-view.solid.tsx";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { ShellOwner } from "./app-host.tsx";
import { connectLegacyApplicationContext } from "./app-root-lit.ts";
import { renderApplicationShell } from "./app-shell-view.tsx";
import { bootstrapApplication } from "./bootstrap.ts";

setupSidebarTest();

async function mountShell() {
  const runtime = bootstrapApplication();
  const owner = new ShellOwner(document.createElement("openclaw-app-shell"), runtime);
  owner.routeState = { routeId: "chat" };
  const disconnectContext = connectLegacyApplicationContext(owner.element, runtime.context);
  document.body.append(owner.element);
  const view = render(() => renderApplicationShell(owner), {
    container: owner.element,
  });
  onTestFinished(() => {
    view.unmount();
    disconnectContext();
    owner.disconnect();
    runtime.stop();
  });
  await Promise.resolve();
  flush();
  return { owner, runtime, view };
}

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
  owner.routeState = { routeId: "plugins" };
  owner.invalidate();
  flush();
  selected.mockImplementation((surface) => (surface === "workspace" ? replacement : undefined));
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
  owner.invalidate();
  flush();
  owner.routeState = { routeId: "dashboard" };
  owner.invalidate();
  flush();
  expect(view.container.querySelector(".shell")).toBe(shell);
  expect(view.container.querySelector("openclaw-app-sidebar")).toBe(sidebar);
  expect(shell?.isConnected).toBe(true);
});

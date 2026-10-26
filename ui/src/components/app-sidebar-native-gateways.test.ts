/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { nativeGatewaysCapability } from "../app/native-gateways.runtime.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../test-helpers/native-gateways.ts";
import "./app-sidebar.tsx";

setupSidebarTest();
afterEach(() => {
  clearNativeGatewayTestState();
  document.documentElement.classList.remove("openclaw-native-macos");
});

const query = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);
const item = (root: ParentNode, value: string) => query(root, `[data-value="${value}"]`);
const shortcut = (root: ParentNode) =>
  query(root, ".oc-menu-item__details kbd")?.textContent?.replace(/\s+/gu, "").trim();

function publishSnapshot(snapshot: NativeGatewaysSnapshot | null) {
  Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
  window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed", { detail: snapshot }));
}

async function mountNative(key = "agent:main:main") {
  const gateway = createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient);
  const sessions = createSessions("main", [key]);
  const mounted = await mountSidebar(gateway.gateway, sessions);
  const { sidebar } = mounted;
  const click = async (element: HTMLElement) => {
    element.click();
    await sidebar.updateComplete;
  };
  const open = async (gateways = false) => {
    await click(query(sidebar, ".sidebar-identity-card")!);
    const menu = query(sidebar, ".sidebar-identity-menu")!;
    if (gateways) {
      await click(item(menu, "command:gateways")!);
    }
    return menu;
  };
  return { ...mounted, gateway, sessions, click, open };
}

it("closes the session menu on Gateway changes after moves and context replacement", async () => {
  setNativeGatewayTestState("remote");
  const { sidebar, provider, gateway, sessions } = await mountNative("agent:main:recent");
  for (const changeLifetime of [
    () => {},
    () => {
      sidebar.hostElement.remove();
      provider.append(sidebar.hostElement);
    },
    () => provider.setContext(createContext(gateway.gateway, sessions)),
  ]) {
    changeLifetime();
    await sidebar.updateComplete;
    const trigger = query(sidebar, "[data-sidebar-session-menu]")!;
    trigger.click();
    await sidebar.updateComplete;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed"));
    await sidebar.updateComplete;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  }
});

it("lists native gateways and dispatches switching, window, primary, and settings actions", async () => {
  document.documentElement.classList.add("openclaw-native-macos");
  const postMessage = setNativeGatewayTestState("remote")!;
  const [local, remote] = nativeGatewaysCapability()!.snapshot!.gateways;
  const snapshot = {
    gateways: [
      local!,
      { ...remote!, id: "profile:team", health: "error" as const },
      { ...remote!, id: "unknown", name: "Unprobed Gateway", health: "unknown" as const },
    ],
    currentId: "profile:team",
  };
  publishSnapshot(snapshot);
  const { sidebar, open: openIdentity } = await mountNative();
  const open = () => openIdentity(true);
  const choose = async (value: string, modifiers?: MouseEventInit, eventType = "click") => {
    const target = item(await open(), value)!;
    target.dispatchEvent(
      new MouseEvent(eventType, { bubbles: true, cancelable: true, ...modifiers }),
    );
    await sidebar.updateComplete;
    expect(query(sidebar, ".sidebar-identity-menu")).toBeNull();
  };
  const menu = await open();
  const current = item(menu, "command:gateways")!;
  expect(query(current, ".sidebar-gateway-health")?.getAttribute("aria-label")).toBe("Unreachable");
  expect(item(menu, "command:apps")).toBeNull();
  const rows = snapshot.gateways.map(({ id }) => item(menu, `gateway:${encodeURIComponent(id)}`)!);
  expect(
    rows.map((row) => [
      query(row, ".sidebar-gateway-health")?.getAttribute("aria-label"),
      shortcut(row),
    ]),
  ).toEqual([
    ["Connected", "⌘1"],
    ["Unreachable", undefined],
    ["Unknown status", "⌘3"],
  ]);
  expect(query(rows[0]!, ".sidebar-gateway-primary")?.textContent).toBe("primary");
  expect(query(rows[1]!, ".sidebar-gateway-primary")).toBeNull();
  expect(query(rows[1]!, ".sidebar-gateway-check")).not.toBeNull();
  expect(query(rows[0]!, ".sidebar-gateway-check")).toBeNull();
  rows[1]!.click();
  await sidebar.updateComplete;
  expect(postMessage).not.toHaveBeenCalled();
  expect(query(sidebar, ".sidebar-identity-menu")).toBeNull();

  for (const [target, type, id, modifiers, event] of [
    ["gateway:local", "select", "local"],
    ["gateway:profile%3Ateam", "open-window", "profile:team", { metaKey: true }],
    ["gateway:profile%3Ateam", "open-window", "profile:team", { ctrlKey: true }],
    ["gateway:profile%3Ateam", "open-window", "profile:team", { ctrlKey: true }, "contextmenu"],
    ["command:gateway-set-primary", "set-primary", "profile:team"],
    ["command:gateway-settings", "open-settings"],
  ] as const) {
    await choose(target, modifiers, event);
    expect(postMessage).toHaveBeenLastCalledWith({ type, ...(id ? { id } : {}) });
  }
  expect(postMessage).toHaveBeenCalledTimes(6);

  snapshot.gateways = Array.from({ length: 10 }, (_, index) => ({
    ...snapshot.gateways[0]!,
    id: `gateway-${index + 1}`,
    name: `Gateway ${index + 1}`,
  }));
  snapshot.currentId = "gateway-1";
  publishSnapshot(snapshot);
  await open();
  const manyRows = sidebar.querySelectorAll('[data-value^="gateway:"]');
  expect(manyRows).toHaveLength(10);
  expect(shortcut(manyRows[8]!)).toBe("⌘9");
  expect(query(manyRows[9]!, "kbd")).toBeNull();
});

it.each(["missing snapshot", "empty list", "unknown current"] as const)(
  "keeps settings and known gateways available with %s",
  async (state) => {
    setNativeGatewayTestState("local");
    const capability = nativeGatewaysCapability()!;
    const openSettings = vi.spyOn(capability, "openSettings");
    const initial = capability.snapshot!;
    const gateways = state === "unknown current" ? initial.gateways : [];
    publishSnapshot(state === "missing snapshot" ? null : { currentId: "missing", gateways });
    const { sidebar, click, open } = await mountNative();
    const menu = await open();
    const switcher = item(menu, "command:gateways")!;
    expect(switcher.textContent).toContain("Gateway");
    expect(query(switcher, ".sidebar-gateway-health")).toBeNull();
    await click(switcher);
    expect(menu.querySelectorAll('[data-value^="gateway:"]')).toHaveLength(gateways.length);
    expect(query(menu, '[aria-checked="true"]')).toBeNull();
    expect(item(menu, "command:gateway-set-primary")).toBeNull();
    await click(item(menu, "command:gateway-settings")!);
    expect(openSettings).toHaveBeenCalledExactlyOnceWith();
    expect(query(sidebar, ".sidebar-identity-menu")).toBeNull();
  },
);

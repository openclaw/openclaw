/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
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

describe("AppSidebar native Gateway menu", () => {
  it("closes the session menu on Gateway changes after moves and context replacement", async () => {
    setNativeGatewayTestState("remote");
    const gateway = createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient);
    const sessions = createSessions("main", ["agent:main:recent"]);
    const { sidebar, provider } = await mountSidebar(gateway.gateway, sessions);
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
      const trigger = sidebar.querySelector<HTMLButtonElement>("[data-sidebar-session-menu]")!;
      expect(trigger).not.toBeNull();
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
    const capability = nativeGatewaysCapability()!;
    const snapshot = {
      gateways: [
        capability.snapshot!.gateways[0]!,
        { ...capability.snapshot!.gateways[1]!, id: "profile:team", health: "error" as const },
        {
          ...capability.snapshot!.gateways[1]!,
          id: "unknown",
          name: "Unprobed Gateway",
          health: "unknown" as const,
        },
      ],
      currentId: "profile:team",
    };
    const publish = () => {
      Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
      window.dispatchEvent(
        new CustomEvent("openclaw:native-gateways-changed", { detail: snapshot }),
      );
    };
    publish();
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
    );
    const open = async () => {
      sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card")!.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu")!;
      menu.querySelector<HTMLButtonElement>('[data-value="command:gateways"]')!.click();
      await sidebar.updateComplete;
      return menu;
    };
    const choose = async (value: string, modifiers?: MouseEventInit, eventType = "click") => {
      const menu = await open();
      const item = menu.querySelector<HTMLElement>(`[data-value="${value}"]`)!;
      expect(item).not.toBeNull();
      if (modifiers) {
        item.dispatchEvent(
          new MouseEvent(eventType, { bubbles: true, cancelable: true, ...modifiers }),
        );
      } else {
        item.click();
      }
      await sidebar.updateComplete;
      expect(sidebar.querySelector(".sidebar-identity-menu")).toBeNull();
    };
    const menu = await open();
    expect(menu.querySelector(".sidebar-customize-menu__title")?.textContent).toBe("Gateway");
    const current = menu.querySelector<HTMLElement>('[data-value="command:gateways"]')!;
    expect(current.textContent).toContain("Remote Gateway");
    expect(current.querySelector(".sidebar-gateway-health")?.getAttribute("aria-label")).toBe(
      "Unreachable",
    );
    expect(menu.querySelector('[data-value="command:apps"]')).toBeNull();
    const rows = snapshot.gateways.map((gateway) =>
      menu.querySelector<HTMLElement>(`[data-value="gateway:${encodeURIComponent(gateway.id)}"]`)!,
    );
    expect(
      rows.map((row) => row.querySelector(".sidebar-customize-menu__text")?.textContent?.trim()),
    ).toEqual(["Local Gateway", "Remote Gateway", "Unprobed Gateway"]);
    expect(
      rows.map((row) => row.querySelector(".sidebar-gateway-health")?.getAttribute("aria-label")),
    ).toEqual(["Connected", "Unreachable", "Unknown status"]);
    expect(
      rows.map((row) =>
        row.querySelector(".oc-menu-item__details kbd")?.textContent?.replace(/\s+/gu, "").trim(),
      ),
    ).toEqual(["⌘1", undefined, "⌘3"]);
    for (const shortcut of menu.querySelectorAll("kbd")) {
      expect(shortcut.getAttribute("aria-hidden")).toBe("true");
    }
    expect(rows[0]!.querySelector(".sidebar-gateway-primary")?.textContent).toBe("primary");
    expect(rows[1]!.querySelector(".sidebar-gateway-primary")).toBeNull();
    expect(rows[1]!.querySelector(".sidebar-gateway-check")).not.toBeNull();
    expect(rows[0]!.querySelector(".sidebar-gateway-check")).toBeNull();
    rows[1]!.click();
    await sidebar.updateComplete;
    expect(postMessage).not.toHaveBeenCalled();
    expect(sidebar.querySelector(".sidebar-identity-menu")).toBeNull();

    await choose("gateway:local");
    expect(postMessage).toHaveBeenLastCalledWith({ type: "select", id: "local" });
    for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
      await choose("gateway:profile%3Ateam", modifiers);
      expect(postMessage).toHaveBeenLastCalledWith({ type: "open-window", id: "profile:team" });
    }
    // macOS sends a contextmenu event for Control-click instead of click.
    await choose("gateway:profile%3Ateam", { ctrlKey: true }, "contextmenu");
    expect(postMessage).toHaveBeenLastCalledWith({ type: "open-window", id: "profile:team" });
    await choose("command:gateway-set-primary");
    expect(postMessage).toHaveBeenLastCalledWith({ type: "set-primary", id: "profile:team" });
    await choose("command:gateway-settings");
    expect(postMessage).toHaveBeenLastCalledWith({ type: "open-settings" });
    expect(postMessage).toHaveBeenCalledTimes(6);

    snapshot.gateways = [snapshot.gateways[0]!];
    snapshot.currentId = "local";
    publish();
    const singleMenu = await open();
    expect(singleMenu.querySelector('[data-value="gateway:local"]')).not.toBeNull();
    expect(singleMenu.querySelector('[data-value="command:gateway-set-primary"]')).toBeNull();
    expect(singleMenu.querySelector('[data-value="command:gateway-settings"]')).not.toBeNull();

    snapshot.gateways = Array.from({ length: 10 }, (_, index) => ({
      ...snapshot.gateways[0]!,
      id: `gateway-${index + 1}`,
      name: `Gateway ${index + 1}`,
    }));
    snapshot.currentId = "gateway-1";
    publish();
    await sidebar.updateComplete;
    const manyRows = sidebar.querySelectorAll('[data-value^="gateway:"]');
    expect(manyRows).toHaveLength(10);
    expect(
      manyRows[8]!
        .querySelector(".oc-menu-item__details kbd")
        ?.textContent?.replace(/\s+/gu, "")
        .trim(),
    ).toBe("⌘9");
    expect(manyRows[9]!.querySelector("kbd")).toBeNull();
  });

  it.each(["missing snapshot", "empty list", "unknown current"] as const)(
    "keeps settings and known gateways available with %s",
    async (state) => {
      setNativeGatewayTestState("local");
      const capability = nativeGatewaysCapability()!;
      const openSettings = vi.spyOn(capability, "openSettings");
      const initial = capability.snapshot!;
      const snapshot =
        state === "missing snapshot"
          ? null
          : {
              currentId: "missing",
              gateways: state === "empty list" ? [] : initial.gateways,
            };
      Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
      window.dispatchEvent(
        new CustomEvent("openclaw:native-gateways-changed", { detail: snapshot }),
      );
      const { sidebar } = await mountSidebar(
        createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card")!.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu")!;
      const switcher = menu.querySelector<HTMLButtonElement>('[data-value="command:gateways"]')!;
      expect(switcher.textContent).toContain("Gateway");
      expect(switcher.querySelector(".sidebar-gateway-health")).toBeNull();
      switcher.click();
      await sidebar.updateComplete;
      expect(menu.querySelectorAll('[data-value^="gateway:"]')).toHaveLength(
        snapshot?.gateways.length ?? 0,
      );
      expect(menu.querySelector('[aria-checked="true"]')).toBeNull();
      expect(menu.querySelector('[data-value="command:gateway-set-primary"]')).toBeNull();
      menu.querySelector<HTMLButtonElement>('[data-value="command:gateway-settings"]')!.click();
      await sidebar.updateComplete;
      expect(openSettings).toHaveBeenCalledExactlyOnceWith();
      expect(sidebar.querySelector(".sidebar-identity-menu")).toBeNull();
    },
  );
});

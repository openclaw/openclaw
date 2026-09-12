/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { nativeGatewaysCapability } from "../app/native-gateways.runtime.ts";
import {
  createGatewayHarness,
  createSessions,
  mountSidebar,
  setupSidebarTest,
} from "../test-helpers/app-sidebar.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../test-helpers/native-gateways.ts";
import "./app-sidebar.ts";

setupSidebarTest();
afterEach(clearNativeGatewayTestState);

describe("AppSidebar native Gateway menu", () => {
  it("lists native gateways and dispatches switching, window, primary, and settings actions", async () => {
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
    const publish = () =>
      window.dispatchEvent(
        new CustomEvent("openclaw:native-gateways-changed", { detail: snapshot }),
      );
    publish();
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
    );
    const open = async () => {
      sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card")!.click();
      await sidebar.updateComplete;
      return sidebar.querySelector<HTMLElement>(".sidebar-identity-menu")!;
    };
    const choose = async (value: string, modifiers?: MouseEventInit, eventType = "click") => {
      const menu = await open();
      const item = menu.querySelector<HTMLElement>(`wa-dropdown-item[value="${value}"]`)!;
      expect(item).not.toBeNull();
      if (modifiers) {
        item.dispatchEvent(
          new MouseEvent(eventType, { bubbles: true, cancelable: true, ...modifiers }),
        );
      } else {
        // Web Awesome emits wa-select for keyboard activation as well as ordinary clicks.
        menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item }, bubbles: true }));
      }
      await sidebar.updateComplete;
      expect(sidebar.querySelector(".sidebar-identity-menu")).toBeNull();
    };
    const menu = await open();
    expect(menu.querySelector(".sidebar-customize-menu__title")?.textContent).toBe("Gateway");
    const rows = snapshot.gateways.map((gateway) =>
      menu.querySelector<HTMLElement>(
        `wa-dropdown-item[value="gateway:${encodeURIComponent(gateway.id)}"]`,
      )!,
    );
    expect(
      rows.map((row) => row.querySelector(".sidebar-customize-menu__text")?.textContent?.trim()),
    ).toEqual(["Local Gateway", "Remote Gateway", "Unprobed Gateway"]);
    expect(
      rows.map((row) => row.querySelector(".sidebar-gateway-health")?.getAttribute("aria-label")),
    ).toEqual(["Connected", "Unreachable", "Unknown status"]);
    expect(rows[0]!.querySelector(".sidebar-gateway-primary")?.textContent).toBe("primary");
    expect(rows[1]!.querySelector(".sidebar-gateway-primary")).toBeNull();
    expect(rows[1]!.querySelector(".sidebar-gateway-check")).not.toBeNull();
    expect(rows[0]!.querySelector(".sidebar-gateway-check")).toBeNull();
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: rows[1] }, bubbles: true }));
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
    expect(singleMenu.querySelector('wa-dropdown-item[value="gateway:local"]')).not.toBeNull();
    expect(
      singleMenu.querySelector('wa-dropdown-item[value="command:gateway-set-primary"]'),
    ).toBeNull();
    expect(
      singleMenu.querySelector('wa-dropdown-item[value="command:gateway-settings"]'),
    ).not.toBeNull();
  });
});

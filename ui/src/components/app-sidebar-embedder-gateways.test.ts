/* @vitest-environment jsdom */

import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import { describe, expect, it } from "vitest";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGatewayHarness, createSessions, mountSidebar } from "../test-helpers/app-sidebar.ts";
import {
  embedderSnapshot,
  installEmbedderGatewayTestBridge,
} from "../test-helpers/embedder-gateways.ts";
import "./app-sidebar.ts";

setupSidebarTest();

describe("AppSidebar embedder Gateway menu", () => {
  it("renders parent updates in the open menu and sends supported selections to the embedder", async () => {
    const bridge = installEmbedderGatewayTestBridge();
    try {
      const { sidebar } = await mountSidebar(
        createGatewayHarness(new GatewayBrowserClient({ url: "ws://test.invalid" })).gateway,
        createSessions("main", ["agent:main:main"]),
      );
      const open = async () => {
        sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card")!.click();
        await sidebar.updateComplete;
        return sidebar.querySelector<HTMLElement>(".sidebar-identity-menu")!;
      };
      await open();
      expect(bridge.postMessage).toHaveBeenCalledWith(
        { type: "openclaw.embedder.hello", version: 1 },
        "*",
      );
      bridge.publish();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu")!;
      expect(menu.querySelector(".sidebar-customize-menu__title")?.textContent).toBe("Gateway");
      const rows = [
        ...menu.querySelectorAll<WaDropdownItem>('wa-dropdown-item[value^="gateway:"]'),
      ];
      await Promise.all(rows.map((row) => row.updateComplete));
      expect(
        rows.map((row) => row.querySelector(".sidebar-customize-menu__text")?.textContent),
      ).toEqual(["My Claw", "Team"]);
      expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "true"]);
      expect(rows[0]!.querySelector(".sidebar-gateway-primary")?.textContent).toBe("primary");
      expect(menu.querySelector(".sidebar-gateway-details kbd")).toBeNull();

      const modifiedClick = new MouseEvent("click", { metaKey: true, cancelable: true });
      rows[0]!.dispatchEvent(modifiedClick);
      expect(modifiedClick.defaultPrevented).toBe(false);
      expect(bridge.postMessage).toHaveBeenCalledTimes(1);

      const choose = async (value: string) => {
        const currentMenu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu")!;
        const item = currentMenu.querySelector<HTMLElement>(`wa-dropdown-item[value="${value}"]`)!;
        expect(item).not.toBeNull();
        currentMenu.dispatchEvent(
          new CustomEvent("wa-select", { detail: { item }, bubbles: true }),
        );
        await sidebar.updateComplete;
        expect(sidebar.querySelector(".sidebar-identity-menu")).toBeNull();
      };
      await choose("gateway:personal");
      await open();
      await choose("command:gateway-set-primary");
      await open();
      await choose("command:gateway-settings");
      expect(bridge.postMessage.mock.calls.slice(1)).toEqual([
        [{ type: "openclaw.embedder.select", id: "personal" }, "*"],
        [{ type: "openclaw.embedder.set-primary", id: "team" }, "*"],
        [{ type: "openclaw.embedder.open-settings" }, "*"],
      ]);

      await open();
      bridge.publish({
        ...embedderSnapshot,
        gateways: [
          {
            ...embedderSnapshot.gateways[1],
            name: "Team updated",
            health: "error",
            canPromote: false,
          },
        ],
      });
      await sidebar.updateComplete;
      expect(sidebar.querySelectorAll('wa-dropdown-item[value^="gateway:"]')).toHaveLength(1);
      expect(sidebar.querySelector(".sidebar-gateway-health")?.getAttribute("aria-label")).toBe(
        "Unreachable",
      );
      expect(sidebar.querySelector('[value="gateway:team"]')?.textContent).toContain(
        "Team updated",
      );
      expect(sidebar.querySelector('[value="command:gateway-set-primary"]')).toBeNull();
      expect(sidebar.querySelector(".sidebar-identity-card__gateway")?.textContent).toContain(
        "Team updated",
      );
    } finally {
      bridge.dispose();
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("sidebar agent menu layout", () => {
  it("centers short and wrapped names under active and inactive avatars", async () => {
    await import("./app-sidebar.ts");
    const { createGatewayHarness, createSessions, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Molty" },
          { id: "release", name: "Release reviewer" },
          { id: "research", name: "Research planning and documentation assistant" },
          { id: "scout", name: "Scout" },
        ],
      },
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;

    const tiles = Array.from(
      sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-menu__agent-switch"),
    );
    expect(tiles).toHaveLength(4);
    await expect
      .poll(() => tiles.map((tile) => tile.getAttribute("aria-checked")))
      .toEqual(["true", "false", "false", "false"]);
    await document.fonts.ready;
    for (const tile of tiles) {
      const avatar = tile.querySelector<HTMLElement>(".sidebar-agent-menu__agent-avatar")!;
      const label = tile.querySelector<HTMLElement>(".agent-select__option-label")!;
      await expect.poll(() => avatar.getBoundingClientRect().width).toBeGreaterThan(0);
      const avatarBox = avatar.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      expect(
        Math.abs(labelBox.x + labelBox.width / 2 - (avatarBox.x + avatarBox.width / 2)),
        label.textContent ?? "agent name",
      ).toBeLessThanOrEqual(1);
    }
  });
});

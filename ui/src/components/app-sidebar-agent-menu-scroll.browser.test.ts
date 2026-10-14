import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("sidebar agent menu scrolling", () => {
  it("reveals the selected agent on click while preserving hover focus", async () => {
    await import("./app-sidebar.tsx");
    const { createGatewayHarness, createSessions, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const { page, userEvent } = await import("vitest/browser");
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    onTestFinished(() => page.viewport(viewport.width, viewport.height));
    await page.viewport(1440, 480);
    const { sidebar } = await mountSidebar(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
      createSessions("agent-39", ["agent:agent-39:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: Array.from({ length: 40 }, (_, index) => ({
          id: index === 0 ? "main" : `agent-${index}`,
          name: `Research and documentation agent ${index}`,
        })),
      },
    );
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!;
    const activeRow = () =>
      sidebar.querySelector<HTMLElement>(".sidebar-agent-menu__agent-switch--active")!;
    const selectedAgentIsVisible = () => {
      const row = activeRow();
      const bounds = row.getBoundingClientRect();
      const list = row.parentElement!.getBoundingClientRect();
      return bounds.top >= list.top - 1 && bounds.bottom <= list.bottom + 1;
    };

    trigger.click();
    await expect.poll(() => activeRow()?.dataset.value).toBe("agent:agent-39");
    await expect.poll(() => document.activeElement).toBe(activeRow());
    await expect.poll(selectedAgentIsVisible).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => sidebar.querySelector(".sidebar-agent-menu")).toBeNull();

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await page.elementLocator(trigger).hover();
    await expect.poll(() => activeRow()?.dataset.value).toBe("agent:agent-39");
    await expect.poll(selectedAgentIsVisible).toBe(true);
    expect(document.activeElement).toBe(input);
  });
});

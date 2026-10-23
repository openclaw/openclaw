/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";

describe("sidebar agent creation access", () => {
  it.each([
    {
      name: "read-only browser",
      hello: gatewayHelloForMethods(["agents.create"], ["operator.read"]),
    },
    { name: "missing method", hello: gatewayHelloForMethods([]) },
    { name: "unpaired browser", hello: null },
  ])("explains unavailable creation for a $name and updates after reconnect", async ({ hello }) => {
    const request = vi.fn().mockResolvedValue({});
    // SAFETY: This sidebar fixture uses only request; the harness supplies Gateway state.
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gateway.publish({ hello });
    const { sidebar, context } = await mountSidebar(
      gateway.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const create = sidebar.querySelector<HTMLButtonElement>('[data-value="command:new-agent"]');
    expect(create).not.toBeNull();
    expect(create?.disabled).toBe(true);
    expect(create?.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(create?.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("agents.create");
    expect(reason?.textContent).toContain("operator.admin");
    expect(reason?.textContent).toContain("Pair");
    expect(reason?.textContent).toContain("reconnect");
    expect(create?.contains(reason)).toBe(true);
    expect(create?.hasAttribute("title")).toBe(false);
    create?.click();
    expect(request.mock.calls.some(([method]) => method === "agents.create")).toBe(false);
    expect(context.navigate).not.toHaveBeenCalled();
    expect(context.chatSubmissions.creation).toBeUndefined();

    gateway.publish({ hello: gatewayHelloForMethods(["agents.create"]) });
    await vi.waitFor(() => {
      expect(create?.disabled).toBe(false);
      expect(create?.hasAttribute("aria-describedby")).toBe(false);
      expect(reason?.isConnected).toBe(false);
    });
  });
});

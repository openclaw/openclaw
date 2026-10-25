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
      reason: "You need operator.admin to perform this action",
    },
    {
      name: "missing method",
      hello: gatewayHelloForMethods([]),
      reason: "This Gateway does not support agent creation",
    },
    {
      name: "disconnected browser with a previous handshake",
      hello: gatewayHelloForMethods(["agents.create"]),
      phase: "reconnecting" as const,
      reason: "Connect to the Gateway to perform this action",
    },
    {
      name: "unpaired browser",
      hello: null,
      reason: "Connect to the Gateway to perform this action",
    },
  ])("explains $name and recovers", async ({ hello, phase, reason }) => {
    const request = vi.fn().mockResolvedValue({});
    // SAFETY: This sidebar fixture uses only request; the harness supplies Gateway state.
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gateway.publish({ hello, phase: phase ?? "connected" });
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
    expect(create?.disabled).toBe(false);
    expect(create?.getAttribute("aria-disabled")).toBe("true");
    expect(create?.textContent?.trim()).toBe("Create new agent");
    expect(create?.getAttribute("title")).toBe(reason);
    expect(create?.getAttribute("aria-description")).toBe(reason);
    create?.click();
    expect(request.mock.calls.some(([method]) => method === "agents.create")).toBe(false);
    expect(context.navigate).not.toHaveBeenCalled();
    expect(context.chatSubmissions.creation).toBeUndefined();

    gateway.publish({ hello: gatewayHelloForMethods(["agents.create"]), phase: "connected" });
    await vi.waitFor(() => {
      expect(create?.disabled).toBe(false);
      expect(create?.hasAttribute("aria-description")).toBe(false);
      expect(create?.hasAttribute("title")).toBe(false);
    });
  });
});

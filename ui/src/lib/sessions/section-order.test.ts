// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";

describe("gateway-owned sidebar section order", () => {
  it("sends and publishes the order via groupsReorder", async () => {
    const sectionOrder = ["catalog:codex", "work", "category:Beta", "ungrouped", "category:Alpha"];
    const request = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe("sessions.groups.reorder");
      expect(params).toEqual({ names: ["Beta", "Alpha"], sectionOrder });
      return {
        ok: true,
        groups: [
          { name: "Beta", position: 0 },
          { name: "Alpha", position: 1 },
        ],
        sectionOrder,
      };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability({
      snapshot: {
        client,
        phase: "connected",
        sessionKey: "agent:main:main",
        assistantAgentId: "main",
        hello: { features: { methods: ["sessions.groups.reorder"] } } as GatewayHelloOk,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    await expect(sessions.groupsReorder(["Beta", "Alpha"], sectionOrder)).resolves.toBe(
      "completed",
    );
    expect(sessions.state.sectionOrder).toEqual(sectionOrder);
    sessions.dispose();
  });
});

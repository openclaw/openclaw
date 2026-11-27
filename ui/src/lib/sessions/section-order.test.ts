// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createTestSessionCapability } from "./session-capability.test-support.ts";

describe("gateway-owned sidebar section order", () => {
  it("sends and publishes the order", async () => {
    const sectionOrder = ["catalog:codex", "work", "category:Beta", "ungrouped", "category:Alpha"];
    const savedSectionOrder = [
      "work",
      "catalog:codex",
      "category:Beta",
      "ungrouped",
      "category:Alpha",
    ];
    const saved = {
      groups: [
        { name: "Beta", position: 0 },
        { name: "Alpha", position: 1 },
      ],
      sectionOrder: savedSectionOrder,
    };
    const listed = createDeferred<typeof saved>();
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "sessions.groups.put") {
        expect(params).toEqual({ names: ["Beta", "Alpha"], sectionOrder });
        return saved;
      }
      if (method === "sessions.groups.list") {
        expect(params).toEqual({});
        return listed.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createTestSessionCapability({
      snapshot: {
        client,
        phase: "connected",
        sessionKey: "agent:main:main",
        assistantAgentId: "main",
        hello: {
          features: {
            methods: ["sessions.groups.put", "sessions.groups.list"],
          },
        } as GatewayHelloOk,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    try {
      await expect(sessions.groupsPut(["Beta", "Alpha"], sectionOrder)).resolves.toBe("completed");
      expect(sessions.state.groups).toEqual(["Beta", "Alpha"]);
      expect(sessions.state.sectionOrder).toEqual(savedSectionOrder);
    } finally {
      listed.resolve(saved);
      await sessions.groupsLoad();
      sessions.dispose();
    }
  });
});

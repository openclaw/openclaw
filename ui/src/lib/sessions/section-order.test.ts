// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionRequest } from "./hydration-family.test-support.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";

describe("gateway-owned sidebar section order", () => {
  it("previews the requested order without persisting it, then uses the Gateway order", async () => {
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
    const confirmed = createDeferred<typeof saved>();
    const listed = createDeferred<typeof saved>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.groups.put") {
        expect(params).toEqual({ names: ["Beta", "Alpha"], sectionOrder });
        return confirmed.promise;
      }
      if (method === "sessions.groups.list") {
        expect(params).toEqual({});
        return listed.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway } = createGatewayHarness(createTestGatewayClient(request), [
      "sessions.groups.put",
      "sessions.groups.list",
    ]);
    const sessions = createTestSessionCapability(gateway);

    try {
      const move = sessions.groupsPut(["Beta", "Alpha"], sectionOrder);
      expect(sessions.pendingSectionOrder).toEqual(sectionOrder);
      expect(sessions.state.sectionOrder).toEqual([]);
      confirmed.resolve(saved);
      await expect(move).resolves.toBe("completed");
      expect(sessions.pendingSectionOrder).toBeUndefined();
      expect(sessions.state.groups).toEqual(["Beta", "Alpha"]);
      expect(sessions.state.sectionOrder).toEqual(savedSectionOrder);
    } finally {
      listed.resolve(saved);
      await sessions.groupsLoad();
      sessions.dispose();
    }
  });

  it("keeps the later drop visible when the first write fails, then discards a retired list", async () => {
    type Catalog = { groups: never[]; sectionOrder: string[] };
    const first = createDeferred<never>();
    const second = createDeferred<Catalog>();
    const staleList = createDeferred<Catalog>();
    const firstOrder = ["groups", "work", "ungrouped"];
    const secondOrder = ["work", "groups", "ungrouped"];
    const saved = { groups: [], sectionOrder: secondOrder };
    const put = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const request = sessionRequest({
      "sessions.groups.put": put,
      "sessions.groups.list": vi
        .fn()
        .mockReturnValueOnce(staleList.promise)
        .mockResolvedValue(saved),
    });
    const { gateway } = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);
    const olderRead = sessions.groupsLoad();
    const moveOne = sessions.groupsPut([], firstOrder);
    const moveTwo = sessions.groupsPut([], secondOrder);
    expect(put).toHaveBeenCalledTimes(1);
    expect(sessions.pendingSectionOrder).toEqual(secondOrder);
    first.reject(new Error("first drop rejected"));
    await expect(moveOne).rejects.toThrow("first drop rejected");
    expect(put).toHaveBeenLastCalledWith({ names: [], sectionOrder: secondOrder });
    expect(sessions.pendingSectionOrder).toEqual(secondOrder);
    second.resolve(saved);
    await expect(moveTwo).resolves.toBe("completed");
    staleList.resolve({ groups: [], sectionOrder: firstOrder });
    await olderRead;
    expect(sessions.pendingSectionOrder).toBeUndefined();
    expect(sessions.state.sectionOrder).toEqual(secondOrder);
  });
});

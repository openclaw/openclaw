import { describe, expect, it } from "vitest";
import { matchesMessagingToolDeliveryTarget } from "./delivery-dispatch.js";

// Test the type guard added to normalizeDeliveryTarget
// This is a regression test for TypeError when channel or to is undefined
describe("normalizeDeliveryTarget type guards", () => {
  it("module loads without errors", async () => {
    // Verify the module loads successfully with the type guard in place
    const module = await import("./delivery-dispatch.js");
    expect(module).toBeDefined();
    expect(module.dispatchCronDelivery).toBeDefined();
    expect(module.matchesMessagingToolDeliveryTarget).toBeDefined();
  });

  it("rejects undefined channel via matchesMessagingToolDeliveryTarget", () => {
    // Test the type guard indirectly through the public API
    // matchesMessagingToolDeliveryTarget calls normalizeDeliveryTarget internally
    const target = { provider: "telegram", to: "user123" };
    const delivery = { channel: undefined as unknown as string, to: "user123" };

    // Should return false when channel is undefined (guard bypassed via type cast)
    expect(matchesMessagingToolDeliveryTarget(target, delivery as unknown as typeof delivery)).toBe(
      false,
    );
  });

  it("rejects undefined to via matchesMessagingToolDeliveryTarget", () => {
    const target = { provider: "telegram", to: "user123" };
    const delivery = { channel: "telegram", to: undefined as unknown as string };

    expect(matchesMessagingToolDeliveryTarget(target, delivery as unknown as typeof delivery)).toBe(
      false,
    );
  });

  it("rejects null channel via matchesMessagingToolDeliveryTarget", () => {
    const target = { provider: "telegram", to: "user123" };
    const delivery = { channel: null as unknown as string, to: "user123" };

    expect(matchesMessagingToolDeliveryTarget(target, delivery as unknown as typeof delivery)).toBe(
      false,
    );
  });

  it("rejects null to via matchesMessagingToolDeliveryTarget", () => {
    const target = { provider: "telegram", to: "user123" };
    const delivery = { channel: "telegram", to: null as unknown as string };

    expect(matchesMessagingToolDeliveryTarget(target, delivery as unknown as typeof delivery)).toBe(
      false,
    );
  });

  it("accepts valid strings via matchesMessagingToolDeliveryTarget", () => {
    const target = { provider: "telegram", to: "user123" };
    const delivery = { channel: "telegram", to: "user123" };

    expect(matchesMessagingToolDeliveryTarget(target, delivery)).toBe(true);
  });

  it("normalizes Feishu chat: prefix correctly", () => {
    const target = { provider: "feishu", to: "chat:oc_xxxxxx" };
    const delivery = { channel: "feishu", to: "oc_xxxxxx" };

    expect(matchesMessagingToolDeliveryTarget(target, delivery)).toBe(true);
  });

  it("strips :topic:NNN suffix from message targets", () => {
    const target = { provider: "telegram", to: "user123:topic:999" };
    const delivery = { channel: "telegram", to: "user123" };

    expect(matchesMessagingToolDeliveryTarget(target, delivery)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  resolveExternalBestEffortDeliveryTarget,
  shouldDowngradeDeliveryToSessionOnly,
} from "./best-effort-delivery.js";

describe("best-effort delivery helpers", () => {
  it("resolves external delivery targets only for deliverable channels with to", () => {
    expect(
      resolveExternalBestEffortDeliveryTarget({
        channel: "discord",
        to: "channel:123",
        accountId: "default",
        threadId: "thread-1",
      }),
    ).toEqual({
      deliver: true,
      channel: "discord",
      to: "channel:123",
      accountId: "default",
      threadId: "thread-1",
    });
  });

  it("keeps webchat/internal targets session-only", () => {
    expect(
      resolveExternalBestEffortDeliveryTarget({
        channel: "webchat",
        to: "chat:123",
      }),
    ).toEqual({
      deliver: false,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
    });
  });

  it("returns session-only when to is missing", () => {
    expect(
      resolveExternalBestEffortDeliveryTarget({
        channel: "telegram",
      }),
    ).toEqual({
      deliver: false,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
    });
  });

  it("downgrades to session-only only for best-effort internal delivery requests", () => {
    expect(
      shouldDowngradeDeliveryToSessionOnly({
        wantsDelivery: true,
        bestEffortDeliver: true,
        resolvedChannel: "webchat",
      }),
    ).toBe(true);

    expect(
      shouldDowngradeDeliveryToSessionOnly({
        wantsDelivery: true,
        bestEffortDeliver: false,
        resolvedChannel: "webchat",
      }),
    ).toBe(false);

    expect(
      shouldDowngradeDeliveryToSessionOnly({
        wantsDelivery: true,
        bestEffortDeliver: true,
        resolvedChannel: "discord",
      }),
    ).toBe(false);
  });
});

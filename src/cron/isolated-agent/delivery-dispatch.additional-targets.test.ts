/**
 * Tests for additional targets delivery functionality.
 *
 * This feature allows cron jobs to fan out the same payloads to multiple
 * delivery targets after the primary delivery succeeds.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([{ ok: true }]),
}));

vi.mock("../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn().mockReturnValue({}),
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
}));

vi.mock("./delivery-target.js", () => ({
  resolveDeliveryTarget: vi.fn(),
}));

import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { deliverToAdditionalTargets } from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

describe("deliverToAdditionalTargets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers payloads to all additional targets successfully", async () => {
    const mockResolveDeliveryTarget = resolveDeliveryTarget as ReturnType<typeof vi.fn>;
    mockResolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123456",
      accountId: undefined,
      threadId: undefined,
    });

    const results = await deliverToAdditionalTargets({
      cfg: {} as never,
      deps: {} as never,
      agentId: "main",
      agentSessionKey: "agent:main",
      targets: [
        { channel: "telegram", to: "123456" },
        { channel: "signal", to: "+15550001111" },
      ],
      payloads: [{ text: "Hello world" }],
      bestEffort: false,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      channel: "telegram",
      to: "123456",
      delivered: true,
    });
    expect(results[1]).toEqual({
      channel: "signal",
      to: "+15550001111",
      delivered: true,
    });
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(2);
  });

  it("continues to next target when one target resolution fails", async () => {
    const mockResolveDeliveryTarget = resolveDeliveryTarget as ReturnType<typeof vi.fn>;
    mockResolveDeliveryTarget
      .mockResolvedValueOnce({
        ok: true,
        channel: "telegram",
        to: "123456",
        accountId: undefined,
        threadId: undefined,
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { message: "channel not configured" },
      });

    const results = await deliverToAdditionalTargets({
      cfg: {} as never,
      deps: {} as never,
      agentId: "main",
      agentSessionKey: "agent:main",
      targets: [
        { channel: "telegram", to: "123456" },
        { channel: "invalid", to: "user-abc" },
      ],
      payloads: [{ text: "Hello world" }],
      bestEffort: false,
    });

    expect(results).toHaveLength(2);
    expect(results[0].delivered).toBe(true);
    expect(results[1].delivered).toBe(false);
    expect(results[1].error).toBe("channel not configured");
  });

  it("continues to next target when delivery fails", async () => {
    const mockResolveDeliveryTarget = resolveDeliveryTarget as ReturnType<typeof vi.fn>;
    mockResolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123456",
      accountId: undefined,
      threadId: undefined,
    });

    const mockDeliverOutbound = deliverOutboundPayloads as ReturnType<typeof vi.fn>;
    mockDeliverOutbound
      .mockResolvedValueOnce([{ ok: true }])
      .mockRejectedValueOnce(new Error("network error"));

    const results = await deliverToAdditionalTargets({
      cfg: {} as never,
      deps: {} as never,
      agentId: "main",
      agentSessionKey: "agent:main",
      targets: [
        { channel: "telegram", to: "123456" },
        { channel: "signal", to: "+15550001111" },
      ],
      payloads: [{ text: "Hello world" }],
      bestEffort: false,
    });

    expect(results).toHaveLength(2);
    expect(results[0].delivered).toBe(true);
    expect(results[1].delivered).toBe(false);
    expect(results[1].error).toBe("network error");
  });

  it("passes accountId to resolved delivery target", async () => {
    const mockResolveDeliveryTarget = resolveDeliveryTarget as ReturnType<typeof vi.fn>;
    mockResolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123456",
      accountId: "bot-coordinator",
      threadId: undefined,
    });

    await deliverToAdditionalTargets({
      cfg: {} as never,
      deps: {} as never,
      agentId: "main",
      agentSessionKey: "agent:main",
      targets: [{ channel: "telegram", to: "123456", accountId: "bot-coordinator" }],
      payloads: [{ text: "Hello world" }],
      bestEffort: false,
    });

    expect(mockResolveDeliveryTarget).toHaveBeenCalledWith(expect.anything(), "main", {
      channel: "telegram",
      to: "123456",
      accountId: "bot-coordinator",
    });
  });

  it("handles empty targets array", async () => {
    const results = await deliverToAdditionalTargets({
      cfg: {} as never,
      deps: {} as never,
      agentId: "main",
      agentSessionKey: "agent:main",
      targets: [],
      payloads: [{ text: "Hello world" }],
      bestEffort: false,
    });

    expect(results).toHaveLength(0);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("uses bestEffort flag when delivering", async () => {
    const mockResolveDeliveryTarget = resolveDeliveryTarget as ReturnType<typeof vi.fn>;
    mockResolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123456",
      accountId: undefined,
      threadId: undefined,
    });

    await deliverToAdditionalTargets({
      cfg: {} as never,
      deps: {} as never,
      agentId: "main",
      agentSessionKey: "agent:main",
      targets: [{ channel: "telegram", to: "123456" }],
      payloads: [{ text: "Hello world" }],
      bestEffort: true,
    });

    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        bestEffort: true,
      }),
    );
  });
});

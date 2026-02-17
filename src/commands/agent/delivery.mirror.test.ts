import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

const {
  deliverOutboundPayloadsMock,
  resolveOutboundSessionRouteMock,
  resolveAgentDeliveryPlanMock,
  resolveAgentOutboundTargetMock,
} = vi.hoisted(() => ({
  deliverOutboundPayloadsMock: vi.fn(),
  resolveOutboundSessionRouteMock: vi.fn(),
  resolveAgentDeliveryPlanMock: vi.fn(),
  resolveAgentOutboundTargetMock: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: resolveOutboundSessionRouteMock,
}));

vi.mock("../../infra/outbound/agent-delivery.js", () => ({
  resolveAgentDeliveryPlan: resolveAgentDeliveryPlanMock,
  resolveAgentOutboundTarget: resolveAgentOutboundTargetMock,
}));

import { deliverAgentCommandResult } from "./delivery.js";

describe("deliverAgentCommandResult mirroring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentDeliveryPlanMock.mockReturnValue({
      resolvedChannel: "telegram",
      resolvedTo: "123456",
      resolvedThreadId: undefined,
      resolvedReplyToId: undefined,
      resolvedAccountId: undefined,
    });
    resolveAgentOutboundTargetMock.mockReturnValue({
      resolvedTarget: { ok: true },
      resolvedTo: "123456",
    });
    deliverOutboundPayloadsMock.mockResolvedValue([{ messageId: "m1" }]);
  });

  it("mirrors to resolved outbound session when target session differs", async () => {
    resolveOutboundSessionRouteMock.mockResolvedValue({
      sessionKey: "agent:main:telegram:chat:123456",
    });

    await deliverAgentCommandResult({
      cfg: {} as unknown as OpenClawConfig,
      deps: {} as unknown as CliDeps,
      runtime: { log: vi.fn() } as unknown as RuntimeEnv,
      opts: {
        message: "hello",
        deliver: true,
        channel: "telegram",
        to: "123456",
        sessionKey: "agent:main:hook:gmail:abc",
      },
      sessionEntry: undefined,
      result: { meta: {} } as unknown as { meta: unknown },
      payloads: [{ text: "hello" }] as unknown as Array<{ text: string }>,
    });

    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloadsMock.mock.calls[0][0]).toMatchObject({
      mirror: {
        sessionKey: "agent:main:telegram:chat:123456",
        text: "hello",
      },
    });
  });

  it("does not mirror when outbound session matches source session", async () => {
    resolveOutboundSessionRouteMock.mockResolvedValue({
      sessionKey: "agent:main:telegram:chat:123456",
    });

    await deliverAgentCommandResult({
      cfg: {} as unknown as OpenClawConfig,
      deps: {} as unknown as CliDeps,
      runtime: { log: vi.fn() } as unknown as RuntimeEnv,
      opts: {
        message: "hello",
        deliver: true,
        channel: "telegram",
        to: "123456",
        sessionKey: "agent:main:telegram:chat:123456",
      },
      sessionEntry: undefined,
      result: { meta: {} } as unknown as { meta: unknown },
      payloads: [{ text: "hello" }] as unknown as Array<{ text: string }>,
    });

    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloadsMock.mock.calls[0][0].mirror).toBeUndefined();
  });
});

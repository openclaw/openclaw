import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";

const mocks = vi.hoisted(() => ({
  resolveAgentDeliveryPlanWithSessionRoute: vi.fn(),
  resolveAgentOutboundTarget: vi.fn(),
  resolveMessageChannelSelection: vi.fn(),
}));

vi.mock("../../infra/outbound/agent-delivery.js", () => ({
  resolveAgentDeliveryPlanWithSessionRoute: mocks.resolveAgentDeliveryPlanWithSessionRoute,
  resolveAgentOutboundTarget: mocks.resolveAgentOutboundTarget,
}));
vi.mock("../../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

const { resolveAgentDeliveryPhase } = await import("./agent-delivery-phase.js");

describe("resolveAgentDeliveryPhase", () => {
  beforeEach(() => {
    mocks.resolveAgentDeliveryPlanWithSessionRoute.mockReset();
    mocks.resolveAgentOutboundTarget.mockReset();
    mocks.resolveMessageChannelSelection.mockReset();
  });

  it("renders a strict target-resolution failure without its Error class", async () => {
    const targetError = Object.assign(new Error('Reserved target "current" for Telegram'), {
      code: "INVALID_TARGET",
    });
    mocks.resolveAgentDeliveryPlanWithSessionRoute.mockResolvedValue({
      baseDelivery: {},
      resolvedChannel: "telegram",
      resolvedTo: "current",
      deliveryTargetMode: "explicit",
      targetResolutionError: targetError,
    });
    const respond = vi.fn();

    await resolveAgentDeliveryPhase({
      request: {
        message: "strict delivery",
        deliver: true,
        idempotencyKey: "strict-target-resolution",
      },
      cfg: {},
      agentId: "main",
      replyTo: "",
      to: "current",
      bestEffortDeliver: false,
      runId: "strict-target-resolution",
      client: null,
      context: { chatAbortControllers: new Map() } as never,
      respond,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Reserved target "current" for Telegram | INVALID_TARGET',
    });
  });

  describe.each([
    { name: "ordinary", sessionKey: "agent:main:dashboard:ordinary", incognito: false },
    {
      name: "Incognito key",
      sessionKey: "agent:main:dashboard:incognito-private",
      incognito: false,
    },
    { name: "Incognito entry", sessionKey: "agent:main:dashboard:private-entry", incognito: true },
  ])("$name delivery diagnostics", ({ name, sessionKey, incognito }) => {
    it.each(["target", "channel"] as const)(
      "preserves strict and best-effort %s failures without private error logs",
      async (source) => {
        const privateMessage = "synthetic-private-delivery-error";
        const failure = new Error(privateMessage);
        mocks.resolveAgentDeliveryPlanWithSessionRoute.mockResolvedValue({
          baseDelivery: {},
          resolvedChannel: source === "target" ? "telegram" : "webchat",
          ...(source === "target" ? { targetResolutionError: failure } : {}),
        });
        mocks.resolveAgentOutboundTarget.mockReturnValue({
          resolvedTarget: { ok: false, error: failure },
        });
        mocks.resolveMessageChannelSelection.mockRejectedValue(failure);
        const respond = vi.fn();
        const info = vi.fn();
        const params = {
          request: {
            message: "synthetic prompt",
            deliver: true,
            idempotencyKey: "private-delivery",
          },
          cfg: {},
          agentId: "main",
          sessionEntry: {
            sessionId: "private-session",
            updatedAt: 1,
            ...(incognito ? { incognito: true as const } : {}),
          },
          resolvedSessionKey: sessionKey,
          replyTo: "",
          to: "",
          bestEffortDeliver: false,
          runId: "private-delivery",
          client: null,
          context: { chatAbortControllers: new Map(), logGateway: { info } } as never,
          respond,
          isWebchatConnect: () => false,
        };

        expect(await resolveAgentDeliveryPhase(params)).toBeUndefined();
        const response = respond.mock.calls[0];
        const error = response?.[2];
        const metadata = response?.[3];
        expect(error?.message).toContain(privateMessage);
        const diagnostics = { errorMessage: error?.message, ...metadata };
        if (name === "ordinary") {
          expect(JSON.stringify(diagnostics)).toContain(privateMessage);
        } else {
          expect.soft(JSON.stringify(diagnostics)).not.toContain(privateMessage);
        }

        respond.mockClear();
        expect(
          await resolveAgentDeliveryPhase({ ...params, bestEffortDeliver: true }),
        ).toMatchObject({ deliver: true });
        expect(respond).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledOnce();
        if (name === "ordinary") {
          expect(JSON.stringify(info.mock.calls)).toContain(privateMessage);
        } else {
          expect(JSON.stringify(info.mock.calls)).not.toContain(privateMessage);
        }
      },
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
import { registerChatAbortController } from "../chat-abort.js";
import type { GatewayContextResolver } from "../server-methods/types.js";

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

  for (const scope of ["local", "foreign Gateway", "foreign store"] as const) {
    it(`observes active session runs only in the selected scope: ${scope}`, async ({ signal }) => {
      const localResolver: GatewayContextResolver = () => undefined;
      const foreignResolver: GatewayContextResolver = () => undefined;
      const storePath = "/synthetic/agent-delivery/local/sessions.db";
      const sessionKey = "agent:main:delivery-scope";
      const sessionId = "delivery-scope-session";
      const target = captureSessionTarget({
        storeScope:
          scope === "foreign store" ? "/synthetic/agent-delivery/other/sessions.db" : storePath,
        sessionKey,
        incarnation: sessionId,
        agentId: "main",
      });
      const source = withPluginRuntimeGatewayContextResolver(
        scope === "foreign Gateway" ? foreignResolver : localResolver,
        () =>
          registerChatAbortController({
            runId: "active-delivery-run",
            sessionKey,
            sessionId,
            agentId: "main",
            timeoutMs: 60_000,
            target,
          }),
      );
      if (!source.entry) {
        throw new Error("Expected fresh delivery source admission");
      }
      const entered = createDeferred();
      const release = createDeferred();
      const active = withSessionTurn(
        { sessionKey, sessionId, target, controllerInput: source.entry.input },
        async (operation) => {
          if (!operation) {
            throw new Error("Expected admitted delivery turn");
          }
          markReplyOperationExecutionStarted(operation);
          operation.setPhase("running");
          entered.resolve();
          await release.promise;
        },
      );
      const context = { resolveGatewayContext: localResolver } as Parameters<
        typeof resolveAgentDeliveryPhase
      >[0]["context"];
      const onRunObserved = vi.fn();
      mocks.resolveAgentDeliveryPlanWithSessionRoute.mockResolvedValue({ baseDelivery: {} });
      try {
        await withinTest(entered.promise, signal);
        await resolveAgentDeliveryPhase({
          request: { message: "observe", idempotencyKey: "new-delivery-run" },
          cfg: {},
          resolvedSessionKey: sessionKey,
          resolvedSessionAgentId: "main",
          storePath,
          replyTo: "",
          to: "",
          bestEffortDeliver: false,
          runId: "new-delivery-run",
          client: null,
          context,
          respond: vi.fn(),
          isWebchatConnect: () => false,
          onRunObserved,
        });
        expect(onRunObserved.mock.calls.map(([runId]) => runId)).toEqual(
          scope === "local" ? ["new-delivery-run", "active-delivery-run"] : ["new-delivery-run"],
        );
      } finally {
        release.resolve();
        await active;
        source.cleanup();
        await source.entry.input.settlement.promise;
      }
    });
  }

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
      context: {} as never,
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
          context: { logGateway: { info } } as never,
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

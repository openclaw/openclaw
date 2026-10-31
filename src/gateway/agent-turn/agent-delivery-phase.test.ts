import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { registerChatAbortController } from "../chat-abort.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";

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
type DeliveryParams = Parameters<typeof resolveAgentDeliveryPhase>[0];
const privateMessage = "synthetic-private-delivery-error";

function expectDiagnostics(value: unknown, ordinary: boolean, soft = false) {
  const matcher = (soft ? expect.soft : expect)(JSON.stringify(value));
  (ordinary ? matcher : matcher.not).toContain(privateMessage);
}

function deliveryParams(overrides: Partial<DeliveryParams>): DeliveryParams {
  return {
    request: { message: "synthetic prompt", deliver: true, idempotencyKey: "private-delivery" },
    cfg: {},
    agentId: "main",
    replyTo: "",
    to: "",
    bestEffortDeliver: false,
    runId: "private-delivery",
    client: null,
    context: {} as never,
    respond: vi.fn(),
    isWebchatConnect: () => false,
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
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
    let releaseClaim: (() => void) | undefined;
    const context = { resolveGatewayContext: localResolver } as DeliveryParams["context"];
    const onRunObserved = vi.fn();
    mocks.resolveAgentDeliveryPlanWithSessionRoute.mockResolvedValue({ baseDelivery: {} });
    try {
      releaseClaim = await withinTest(claimRpcSourceForTest(source.entry), signal);
      await resolveAgentDeliveryPhase(
        deliveryParams({
          request: { message: "observe", idempotencyKey: "new-delivery-run" },
          resolvedSessionKey: sessionKey,
          resolvedSessionAgentId: "main",
          storePath,
          runId: "new-delivery-run",
          context,
          onRunObserved,
        }),
      );
      expect(onRunObserved.mock.calls.map(([runId]) => runId)).toEqual(
        scope === "local" ? ["new-delivery-run", "active-delivery-run"] : ["new-delivery-run"],
      );
    } finally {
      releaseClaim?.();
      source.cleanup();
      await source.entry.input.settlement.promise;
    }
  });
}

describe.each([
  ["ordinary", "ordinary", false],
  ["Incognito key", "incognito-private", false],
  ["Incognito entry", "private-entry", true],
] as const)("%s delivery diagnostics", (name, suffix, incognito) => {
  it.each(["target", "channel"] as const)(
    "preserves strict and best-effort %s failures without private error logs",
    async (source) => {
      const ordinary = name === "ordinary";
      const failure = new Error(privateMessage);
      if (ordinary && source === "target") {
        Object.assign(failure, { code: "INVALID_TARGET" });
      }
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
      const params = deliveryParams({
        sessionEntry: {
          sessionId: "private-session",
          updatedAt: 1,
          ...(incognito ? { incognito: true as const } : {}),
        },
        resolvedSessionKey: `agent:main:dashboard:${suffix}`,
        context: { logGateway: { info } } as never,
        respond,
      });

      expect(await resolveAgentDeliveryPhase(params)).toBeUndefined();
      if (ordinary && source === "target") {
        expect(respond).toHaveBeenCalledWith(false, undefined, {
          code: ErrorCodes.INVALID_REQUEST,
          message: `${privateMessage} | INVALID_TARGET`,
        });
      }
      const [error, metadata] = respond.mock.calls[0]?.slice(2) ?? [];
      expect(error?.message).toContain(privateMessage);
      const diagnostics = { errorMessage: error?.message, ...metadata };
      expectDiagnostics(diagnostics, ordinary, !ordinary);

      respond.mockClear();
      expect(await resolveAgentDeliveryPhase({ ...params, bestEffortDeliver: true })).toMatchObject(
        { deliver: true },
      );
      expect(respond).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledOnce();
      expectDiagnostics(info.mock.calls, ordinary);
    },
  );
});

import { beforeEach, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";

const { callGatewayMock, extractDeliveryInfoMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  extractDeliveryInfoMock: vi.fn(),
}));

vi.mock("../../config/sessions/delivery-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/delivery-info.js")>()),
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

import { createCronTool } from "./cron-tool.js";
import * as gatewayModule from "./gateway.js";

export { callGatewayMock };

export function createTestCronTool(
  opts?: Parameters<typeof createCronTool>[0],
): ReturnType<typeof createCronTool> {
  return createCronTool(opts);
}

export function executeCron(
  args: Record<string, unknown>,
  opts?: Parameters<typeof createCronTool>[0],
) {
  return createTestCronTool(opts).execute("cron", args);
}

export function readGatewayCall(index = 0): { method?: string; params?: Record<string, unknown> } {
  return (
    (callGatewayMock.mock.calls[index]?.[0] as
      | { method?: string; params?: Record<string, unknown> }
      | undefined) ?? { method: undefined, params: undefined }
  );
}

export function buildReminderAgentTurnJob() {
  return {
    name: "reminder",
    schedule: { at: new Date(123).toISOString() },
    payload: { kind: "agentTurn" as const, message: "hello" },
  };
}

export function installCronToolTestFixture() {
  beforeEach(() => {
    const gatewaySpy = vi
      .spyOn(gatewayModule, "callGatewayTool")
      .mockImplementation(async (method, gatewayOpts, params) => {
        const result = await callGatewayMock({ method, params }, gatewayOpts);
        if (
          method === "cron.get" &&
          result !== null &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          Object.hasOwn(result, "payload") &&
          !Object.hasOwn(result, "configRevision")
        ) {
          return { ...result, configRevision: "sha256:test" };
        }
        return result;
      });
    onTestFinished(() => gatewaySpy.mockRestore());
    setRuntimeConfigSnapshot({});
    onTestFinished(clearRuntimeConfigSnapshot);
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValue({ ok: true });
    extractDeliveryInfoMock.mockReset();
    extractDeliveryInfoMock.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
  });
}

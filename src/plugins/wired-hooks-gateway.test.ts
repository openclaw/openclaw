/**
 * Test: gateway_start & gateway_stop hook wiring (server.impl.ts)
 *
 * Since startGatewayServer is heavily integrated, we test the hook runner
 * calls at the unit level by verifying the hook runner functions exist
 * and validating the integration pattern.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("gateway hook runner methods", () => {
  const gatewayCtx = { port: 18789 };

  it.each([
    {
      name: "runGatewayStart invokes registered gateway_start hooks",
      hookName: "gateway_start" as const,
      methodName: "runGatewayStart" as const,
      event: { port: 18789 },
    },
    {
      name: "runGatewayStop invokes registered gateway_stop hooks",
      hookName: "gateway_stop" as const,
      methodName: "runGatewayStop" as const,
      event: { reason: "test shutdown" },
    },
  ] as const)("$name", async ({ hookName, methodName, event }) => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName, handler }]);
    const runner = createHookRunner(registry);

    if (methodName === "runGatewayStart") {
      await runner.runGatewayStart(event, gatewayCtx);
    } else {
      await runner.runGatewayStop(event, gatewayCtx);
    }

    expect(handler).toHaveBeenCalledWith(event, gatewayCtx);
  });

  it("hasHooks returns true for registered gateway hooks", () => {
    const registry = createMockPluginRegistry([{ hookName: "gateway_start", handler: vi.fn() }]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("gateway_start")).toBe(true);
    expect(runner.hasHooks("gateway_stop")).toBe(false);
  });
});

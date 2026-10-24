import { afterEach, expect, it, vi } from "vitest";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { resolveSubagentRunDurationMs } from "../registry/subagent-run-timeout.js";
import {
  callNativeSubagentGateway,
  resolveSubagentAgentGatewayTimeoutMs,
} from "./subagent-spawn-gateway.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const callGateway = vi.hoisted(() => vi.fn());
// mock-isolation: Only transport exports are consumed; unrelated spawn services stay unloaded.
vi.mock("./subagent-spawn.runtime.js", async () => {
  const dispatch = await import("../../../gateway/server-plugin-in-process-dispatch.js");
  const scopes = await import("../../../gateway/method-scopes.js");
  return {
    ...scopes,
    dispatchGatewayMethodInProcess: dispatch.dispatchGatewayMethodInProcess,
    hasInProcessGatewayContext: () => Boolean(dispatch.getInProcessGatewayRequestContext()),
    callGateway,
  };
});

vi.mock("../../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

afterEach(() => {
  spawnTesting.setDepsForTest();
  callGateway.mockReset();
});
const request = { method: "agent", params: { message: "start", idempotencyKey: "child" } };

it("caps Gateway timer delays without shortening semantic run durations", () => {
  expect(resolveSubagentAgentGatewayTimeoutMs(30 * 24 * 60 * 60)).toBe(300_000);
  expect(resolveSubagentRunDurationMs(30 * 24 * 60 * 60)).toBe(2_592_000_000);
});

it.each(["caller", "captured", "scoped"])(
  "rejects a retired %s binding without opening a socket",
  async (binding) => {
    callGateway.mockResolvedValue({ runId: "wrong-gateway", status: "accepted" });
    const resolver = () => undefined;
    const dispatch = () =>
      callNativeSubagentGateway(request, {
        gatewayContextResolver: binding === "captured" ? resolver : undefined,
      });
    const result =
      binding === "caller"
        ? withGatewayToolCallerIdentity(
            { agentId: "main", sessionKey: "agent:main:main", gatewayContextResolver: resolver },
            dispatch,
          )
        : binding === "scoped"
          ? withPluginRuntimeGatewayRequestScope(
              { resolveGatewayContext: resolver, isWebchatConnect: () => false },
              dispatch,
            )
          : dispatch();

    await expect(result).rejects.toThrow("instance binding");
    expect(callGateway).not.toHaveBeenCalled();
  },
);

it("preserves acceptance when the source closes after the child is admitted", async () => {
  let current = true;
  const assertDispatchCurrent = () => {
    if (!current) {
      throw new Error("source closed");
    }
  };
  spawnTesting.setDepsForTest({
    hasInProcessGatewayContext: () => true,
    dispatchGatewayMethodInProcess: async <T>() => {
      assertDispatchCurrent();
      current = false;
      return { runId: "accepted-child", status: "accepted" } as T;
    },
  });
  await expect(
    callNativeSubagentGateway({ ...request, assertDispatchCurrent }),
  ).resolves.toMatchObject({
    response: { runId: "accepted-child" },
  });
});

it("keeps socket dispatch available when no Gateway owner was bound", async () => {
  callGateway.mockResolvedValue({ runId: "remote-run", status: "accepted" });
  await expect(callNativeSubagentGateway(request)).resolves.toEqual({
    response: { runId: "remote-run", status: "accepted" },
    registrationRequired: false,
  });
  expect(callGateway).toHaveBeenCalledOnce();
});

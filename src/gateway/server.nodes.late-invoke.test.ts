import { describe, expect, test, vi } from "vitest";
import type { RequestFrame } from "./protocol/index.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { handleNodeInvokeResult } from "./server-methods/nodes.handlers.invoke-result.js";

describe("late-arriving invoke results", () => {
  test("returns success for unknown invoke ids for both success and error payloads", async () => {
    const nodeId = "node-123";
    const cases = [
      {
        id: "unknown-invoke-id-12345",
        ok: true,
        payloadJSON: JSON.stringify({ result: "late" }),
      },
      {
        id: "another-unknown-invoke-id",
        ok: false,
        error: { code: "FAILED", message: "test error" },
      },
    ] as const;

    for (const params of cases) {
      const respond = vi.fn<RespondFn>();
      const context = {
        nodeRegistry: { handleInvokeResult: () => false },
        logGateway: { debug: vi.fn() },
      } as unknown as GatewayRequestContext;
      const client = {
        connect: { device: { id: nodeId } },
      } as unknown as GatewayClient;

      await handleNodeInvokeResult({
        req: { method: "node.invoke.result" } as unknown as RequestFrame,
        params: { ...params, nodeId } as unknown as Record<string, unknown>,
        client,
        isWebchatConnect: () => false,
        respond,
        context,
      });

      const [ok, payload, error] = respond.mock.lastCall ?? [];

      // Late-arriving results return success instead of error to reduce log noise.
      expect(ok).toBe(true);
      expect(error).toBeUndefined();
      expect(payload?.ok).toBe(true);
      expect(payload?.ignored).toBe(true);
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { createCronTool } from "./cron-tool.js";

describe("automation run execution budget", () => {
  it.each([1_000, undefined, 3_600_000])(
    "advertises the actual run wait plus Gateway transport budget for timeoutMs=%s",
    async (timeoutMs) => {
      const callGatewayTool = vi.fn().mockResolvedValue({
        ok: true,
        enqueued: true,
        runId: "manual:job:1",
      });
      const tool = createCronTool(undefined, { callGatewayTool });
      const args = { action: "run", jobId: "job", runMode: "force", timeoutMs };
      await tool.execute("call-run-budget", args);

      expect(callGatewayTool).toHaveBeenCalledTimes(1);
      const request = callGatewayTool.mock.calls[0];
      if (!request) {
        throw new Error("Expected a cron.run request");
      }
      const [method, gatewayOpts, params] = request;
      expect(method).toBe("cron.run");
      expect(tool.getExecutionTimeoutMs?.(args)).toBe(gatewayOpts.timeoutMs);
      expect(tool.getExecutionTimeoutMs?.(args)).toBeGreaterThan(params.waitTimeoutMs);
      expect(tool.getExecutionTimeoutMs?.({ action: "list", timeoutMs: 1_000 })).toBeUndefined();
    },
  );
});

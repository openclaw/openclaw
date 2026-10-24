import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { CronListParams } from "../../../packages/gateway-protocol/src/index.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withLocalGatewayRequestScope } from "../local-request-context.js";
import { cronHandlers } from "./cron.js";
import { createCronJob } from "./cron.validation.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("lists compact attention facts without automation definitions", async () => {
  await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
    const context = expectDefined(
      getPluginRuntimeGatewayRequestScope()?.context,
      "local Gateway context",
    );
    const autoDisabled = {
      reason: "consecutive-failures" as const,
      atMs: 1_788_587_495_278,
      consecutiveErrors: 3,
    };
    const job = createCronJob({
      agentId: "ops",
      updatedAtMs: 1_788_587_495_278,
      payload: { kind: "agentTurn", message: "Synthetic scheduled instructions. ".repeat(200) },
      state: {
        nextRunAtMs: 1_788_591_095_278,
        lastRunAtMs: 1_788_587_495_278,
        runningAtMs: 0,
        autoDisabled,
        lastStatus: "error",
      },
    });
    vi.spyOn(context.cron, "getDefaultAgentId").mockReturnValue("main");
    vi.spyOn(context.cron, "listPage").mockResolvedValue({
      jobs: [job],
      snapshotRevision: "fixture:cron-1",
      total: 1,
      limit: 1,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    const list = async (params: CronListParams) => {
      const respond = vi.fn();
      await expectDefined(
        cronHandlers["cron.list"],
        "cron.list handler",
      )({
        req: { type: "req", id: "compact-inventory", method: "cron.list" },
        params,
        context,
        client: null,
        respond,
        isWebchatConnect: () => false,
      });
      return respond;
    };
    const respond = await list({ compact: true });
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.objectContaining({
        jobs: [
          expect.objectContaining({
            agentId: "ops",
            updatedAtMs: 1_788_587_495_278,
            runningAtMs: 0,
            autoDisabled,
            lastRunStatus: "error",
            nextRunAtMs: 1_788_591_095_278,
            nextRunAt: "2026-09-05T06:51:35.278Z",
            lastRunAtMs: 1_788_587_495_278,
            lastRunAt: "2026-09-05T05:51:35.278Z",
          }),
        ],
      }),
      undefined,
    );
    const compact = respond.mock.calls[0]?.[1];
    const full = await list({ includeDeliveryPreviews: false });
    expect(JSON.stringify(compact)).not.toContain("Synthetic scheduled instructions");
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(full.mock.calls[0]?.[1])) / 5,
    );
  });
});

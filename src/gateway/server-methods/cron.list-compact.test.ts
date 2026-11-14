import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { CronListParams } from "../../../packages/gateway-protocol/src/index.js";
import { CronStoreSelectionRequiredError } from "../../cron/store/selection-error.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withLocalGatewayRequestScope } from "../local-request-context.js";
import { cronHandlers } from "./cron.js";
import { createCronJob } from "./cron.validation.test-support.js";
import { withPreparedGatewayRead } from "./prepared-read.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

afterEach(() => vi.restoreAllMocks());

it.each(["list", "prepared-list", "status", "run"] as const)(
  "preserves the full unresolved partition inventory and current authority (%s)",
  async (mode) => {
    await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
      const context = expectDefined(
        getPluginRuntimeGatewayRequestScope()?.context,
        "local Gateway context",
      );
      const partition = {
        storeKey: `/old/${"state-directory/".repeat(30)}cron/jobs.json`,
        jobs: 3,
        scratch: 3,
        receipts: 4,
        history: 4,
        quarantine: 0,
        proactiveReceipts: 0,
      };
      const selection = {
        status: "unresolved" as const,
        storePath: "/new/state/cron/jobs.json",
        partitions: [partition],
        message: `Run openclaw doctor --fix and complete the "Select the default cron partition" selection step. Partition inventory: ${JSON.stringify(partition)}`,
      };
      let current = true;
      let revokeDuringRead = false;
      const failSelection = async () => {
        if (revokeDuringRead) {
          current = false;
        }
        throw new CronStoreSelectionRequiredError(selection);
      };
      vi.spyOn(context.cron, "listPage").mockImplementation(failSelection);
      vi.spyOn(context.cron, "status").mockImplementation(failSelection);
      vi.spyOn(context.cron, "readJob").mockImplementation(failSelection);
      const method = mode === "status" ? "cron.status" : mode === "run" ? "cron.run" : "cron.list";
      const params = mode === "run" ? { id: "unresolved-job" } : {};
      const respond = vi.fn();
      const options: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "unresolved-inventory", method },
        params,
        context,
        client: null,
        respond,
        isWebchatConnect: () => false,
        hasCurrentClientAuthority: () => current,
      };
      const handler = expectDefined(cronHandlers[method], "cron handler");
      const invoke = () =>
        mode === "prepared-list"
          ? withPreparedGatewayRead(handler, options, async (read) => {
              await read.run(respond);
            })
          : handler(options);
      await invoke();
      expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
        code: "UNAVAILABLE",
        message: selection.message,
        retryable: false,
        details: { code: "CRON_STORE_SELECTION_REQUIRED", selection },
      });
      respond.mockClear();
      revokeDuringRead = true;
      await expect(invoke()).rejects.toThrow("authority");
      expect(respond).not.toHaveBeenCalled();
    });
  },
);

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
        lastTriggerEvalAtMs: 1_788_587_495_500,
        autoDisabled,
        lastStatus: "error",
        lastMeaningfulResult: {
          outcome: "blocked",
          summary: "Awaiting approval.",
          atMs: 1_788_587_495_000,
        },
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
            lastTriggerEvalAtMs: 1_788_587_495_500,
            autoDisabled,
            lastRunStatus: "error",
            lastMeaningfulResult: {
              outcome: "blocked",
              summary: "Awaiting approval.",
              atMs: 1_788_587_495_000,
            },
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

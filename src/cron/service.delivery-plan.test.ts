import { describe, expect, it } from "vitest";
import type { ChannelId } from "../channels/plugins/types.public.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  withCronServiceForTest,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-delivery-" });

type DeliveryOverride = {
  mode: "none" | "announce";
  channel?: ChannelId;
  to?: string;
};

describe("CronService delivery plan consistency", () => {
  it("treats delivery object without mode as announce without reviving legacy relay fallback", async () => {
    await withCronServiceForTest(
      { makeStorePath, logger: noopLogger, cronEnabled: false },
      async ({ cron, enqueueSystemEvent }) => {
        const job = await cron.add({
          name: "partial-delivery",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "hello" },
          delivery: { channel: "telegram", to: "123" } as DeliveryOverride,
        });

        const result = await cron.run(job.id, "force");
        expect(result).toEqual({ ok: true, ran: true });
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(cron.getJob(job.id)?.state.lastDeliveryStatus).toBe("unknown");
      },
    );
  });
});

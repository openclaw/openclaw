import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  CronJobConfigRevisionConflictError,
  resolveCronJobConfigRevision,
} from "../../cron/config-revision.js";
import { cronHandlers } from "./cron.js";
import {
  createCronJob,
  createCronTestContext,
  createCronTestInvoker,
} from "./cron.validation.test-support.js";

const getRuntimeConfig = () => ({}) as OpenClawConfig;
const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);

describe("cron.remove config revision", () => {
  it("rejects a stale reviewed revision with the current revision", async () => {
    const job = createCronJob();
    const expectedConfigRevision = resolveCronJobConfigRevision(job);
    const actualConfigRevision = `sha256:${"A".repeat(43)}`;
    const context = createCronTestContext(job, getRuntimeConfig);
    context.cron.remove.mockRejectedValueOnce(
      new CronJobConfigRevisionConflictError(expectedConfigRevision, actualConfigRevision),
    );

    const { respond } = await invokeCron(
      "cron.remove",
      { id: job.id, expectedConfigRevision },
      { context },
    );

    expect(context.cron.remove).toHaveBeenCalledWith(job.id, { expectedConfigRevision });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        details: {
          code: "CRON_JOB_CHANGED",
          expectedConfigRevision,
          actualConfigRevision,
        },
      }),
    );
  });

  it("forwards a current reviewed revision to the service", async () => {
    const job = createCronJob();
    const expectedConfigRevision = resolveCronJobConfigRevision(job);
    const context = createCronTestContext(job, getRuntimeConfig);

    const { respond } = await invokeCron(
      "cron.remove",
      { id: job.id, expectedConfigRevision },
      { context },
    );

    expect(context.cron.remove).toHaveBeenCalledWith(job.id, { expectedConfigRevision });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, removed: true }, undefined);
  });
});

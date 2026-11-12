// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createCronJob } from "../../test-helpers/cron.ts";
import { createStateWithRequest } from "./cron.test-support.ts";
import { addCronJob, runCronJob, startCronEdit, toggleCronJob } from "./index.ts";

afterEach(() => vi.restoreAllMocks());

it("localizes missing revisions and queued run feedback at the action owner", async () => {
  const translate = vi.spyOn(i18n, "t");
  const job = createCronJob("job", "Job", { configRevision: undefined });
  const request = vi.fn(async (): Promise<unknown> => undefined);
  const state = createStateWithRequest(request);
  await toggleCronJob(state, job, false);
  expect.soft(translate).toHaveBeenCalledWith("cron.missingConfigRevision", undefined);
  expect(state.cronError).toContain(i18n.t("cron.missingConfigRevision"));
  expect(request).not.toHaveBeenCalled();

  request.mockResolvedValueOnce({ ok: true, ran: true, enqueued: true, runId: "Run-ID" });
  await runCronJob(state, job.id, "force");
  expect.soft(translate).toHaveBeenCalledWith("cron.runQueued", { runId: "Run-ID" });
  expect(state.cronNotice).toContain(i18n.t("cron.runQueued", { runId: "Run-ID" }));
});

it.each([false, true])(
  "localizes conflict recovery feedback (load fails: %s)",
  async (loadFails) => {
    const translate = vi.spyOn(i18n, "t");
    const job = createCronJob("job", "Job", { configRevision: "stale" });
    const request = vi.fn(async (method: string) => {
      if (method === "cron.update") {
        throw Object.assign(new Error("changed"), { details: { code: "CRON_JOB_CHANGED" } });
      }
      if (method === "cron.get") {
        if (loadFails) {
          throw new Error("load failed");
        }
        return { ...job, configRevision: "current" };
      }
      return {};
    });
    const state = createStateWithRequest(request);
    state.cronJobs = [job];
    startCronEdit(state, job);
    state.cronForm.name = "Draft";
    await addCronJob(state);
    const key = loadFails ? "cron.changedOnGatewayLoadFailed" : "cron.changedOnGateway";
    expect.soft(translate).toHaveBeenCalledWith(key, undefined);
    expect(state.cronError).toBe(i18n.t(key));
  },
);

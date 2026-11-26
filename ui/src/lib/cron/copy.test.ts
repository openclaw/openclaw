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
  await runCronJob(state, job.id);
  expect.soft(translate).toHaveBeenCalledWith("cron.runQueued", { runId: "Run-ID" });
  expect(state.cronNotice).toContain(i18n.t("cron.runQueued", { runId: "Run-ID" }));
});

it.each([
  {
    loadFails: false,
    message:
      "This automation changed before your edits could be saved. Review the latest settings shown here, then reapply your edits.",
  },
  {
    loadFails: true,
    message:
      "This automation changed before your edits could be saved. Copy your edits before reloading the page, then review the latest settings in Edit before reapplying them.",
  },
])(
  "localizes stale save recovery feedback (load fails: $loadFails)",
  async ({ loadFails, message }) => {
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
    const key = loadFails ? "cron.saveConflictReloadFailed" : "cron.saveConflictReloaded";
    expect.soft(translate).toHaveBeenCalledWith(key, undefined);
    expect(state.cronEditingJob?.configRevision).toBe(loadFails ? "stale" : "current");
    expect(state.cronError).toBe(message);
  },
);

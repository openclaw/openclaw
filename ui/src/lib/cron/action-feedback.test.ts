// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createCronJob, createStateWithRequest } from "./cron.test-support.ts";
import * as cron from "./index.ts";

function job(id: string) {
  return createCronJob(id, id, {
    displayName: `${id} display name`,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "Synthetic action feedback" },
  });
}

it.each([
  { action: "run", selection: "same" },
  { action: "toggle", selection: "other" },
  { action: "remove", selection: "overview" },
])("attributes a failed $action after selecting $selection", async ({ action, selection }) => {
  const alpha = job("alpha");
  const beta = job("beta");
  const response = createDeferred<unknown>();
  const request = vi.fn(() => response.promise);
  const state = createStateWithRequest(request, { cronJobs: [alpha, beta] });
  cron.startCronEdit(state, alpha);
  const mutation =
    action === "run"
      ? cron.runCronJob(state, alpha.id)
      : action === "toggle"
        ? cron.toggleCronJob(state, alpha, false)
        : cron.removeCronJob(state, alpha);
  expect(state.cronBusy).toBe(true);
  if (selection === "other") {
    cron.startCronEdit(state, beta);
  } else if (selection === "overview") {
    cron.cancelCronEdit(state, null);
  }
  const { cronEditingJob: selected, cronForm: form } = state;
  // A paged list refresh can remove the originating row before the reply arrives.
  state.cronJobs = [beta];
  response.reject(new Error("Synthetic action unavailable"));
  const outcome = await mutation;
  if (action === "run") {
    expect(outcome).toBe(state.cronError);
  }
  expect(state.cronError).toBe(
    selection === "same"
      ? "Synthetic action unavailable"
      : "alpha display name: Synthetic action unavailable",
  );
  expect(state.cronEditingJob).toBe(selected);
  expect(state.cronForm).toBe(form);
  expect(state.cronBusy).toBe(false);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    action === "run" ? "cron.run" : action === "toggle" ? "cron.update" : "cron.remove",
    action === "run"
      ? { id: alpha.id, mode: "force" }
      : action === "toggle"
        ? { id: alpha.id, expectedConfigRevision: alpha.configRevision, patch: { enabled: false } }
        : { id: alpha.id },
  );
});

const outcomes = [
  ["queued", "Run queued. Run ID: run-due", "due", true, "cronNotice"],
  ["not-due", "This automation is not due yet.", "force", false, "cronNotice"],
  ["already-running", "This automation is already running.", "force", false, "cronNotice"],
  ["stopped", "The scheduler is stopped.", "force", false, "cronError"],
  [
    "invalid-spec",
    "This automation has an invalid schedule or payload.",
    "force",
    true,
    "cronError",
  ],
] as const;
it.each(outcomes)(
  "reports %s with history refresh",
  async (reason, message, mode, refresh, field) => {
    const request = vi.fn(async (method: string) => {
      if (method === "cron.runs" && reason === "queued") {
        throw new Error("run history refresh unavailable");
      }
      return method === "cron.run"
        ? reason === "queued"
          ? { ok: true, enqueued: true, runId: "run-due" }
          : { ok: true, ran: false, reason }
        : method === "cron.runs"
          ? { entries: [], total: 0, offset: 0, limit: 50, hasMore: false }
          : {};
    });
    const state = createStateWithRequest(request, { cronRunsScope: "job", cronRunsJobId: "job" });
    expect(await cron.runCronJob(state, "job", mode)).toBeUndefined();
    expect(state.cronError).toBe(field === "cronError" ? `job: ${message}` : null);
    if (field === "cronNotice") {
      expect(state.cronNotice).toBe(`job: ${message}`);
    }
    expect(request).toHaveBeenCalledWith("cron.run", { id: "job", mode });
    if (refresh) {
      expect(request).toHaveBeenCalledWith("cron.runs", expect.objectContaining({ id: "job" }));
    } else {
      expect(request).not.toHaveBeenCalledWith("cron.runs", expect.anything());
    }
  },
);

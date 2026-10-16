// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob } from "../../api/types.ts";
import {
  cancelCronEdit,
  createInitialCronState,
  removeCronJob,
  runCronJob,
  startCronEdit,
  toggleCronJob,
} from "./index.ts";
import type { CronState } from "./types.ts";

function job(id: string): CronJob {
  return {
    id,
    name: id,
    displayName: `${id} display name`,
    configRevision: "synthetic-revision",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Synthetic action feedback" },
    state: {},
  };
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
  startCronEdit(state, alpha);
  const mutation =
    action === "run"
      ? runCronJob(state, alpha.id)
      : action === "toggle"
        ? toggleCronJob(state, alpha, false)
        : removeCronJob(state, alpha);
  expect(state.cronBusy).toBe(true);
  if (selection === "other") {
    startCronEdit(state, beta);
  } else if (selection === "overview") {
    cancelCronEdit(state, null);
  }
  const selected = state.cronEditingJob;
  const form = state.cronForm;
  // A paged list refresh can remove the originating row before the reply arrives.
  state.cronJobs = [beta];
  response.reject(new Error("Synthetic action unavailable"));
  await mutation;
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

function createStateWithRequest(request: unknown, overrides: Partial<CronState>): CronState {
  return {
    ...createInitialCronState({
      connected: true,
      client: { request } as unknown as CronState["client"],
    }),
    ...overrides,
  };
}

it.each([
  ["queued", "Run queued. Run ID: run-due", "due", true],
  ["not-due", "This automation is not due yet.", "force", false],
  ["already-running", "This automation is already running.", "force", false],
  ["stopped", "The scheduler is stopped.", "force", false],
  ["invalid-spec", "This automation has an invalid schedule or payload.", "force", true],
] as const)(
  "reports %s and refreshes only recorded runs",
  async (reason, message, mode, refresh) => {
    const request = vi.fn(async (method: string) => {
      if (method === "cron.run") {
        return reason === "queued"
          ? { ok: true, enqueued: true, runId: "run-due" }
          : { ok: true, ran: false, reason };
      }
      if (method === "cron.runs") {
        if (reason === "queued") {
          throw new Error("run history refresh unavailable");
        }
        return { entries: [], total: 0, offset: 0, limit: 50, hasMore: false };
      }
      return {};
    });
    const state = createStateWithRequest(request, { cronRunsScope: "job", cronRunsJobId: "job" });
    await runCronJob(state, "job", mode);
    expect(state.cronError).toBe(`job: ${message}`);
    expect(request).toHaveBeenCalledWith("cron.run", { id: "job", mode });
    if (refresh) {
      expect(request).toHaveBeenCalledWith("cron.runs", expect.objectContaining({ id: "job" }));
    } else {
      expect(request).not.toHaveBeenCalledWith("cron.runs", expect.anything());
    }
  },
);

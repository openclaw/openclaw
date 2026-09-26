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

it.each(
  (["run", "toggle", "remove"] as const).flatMap((action) =>
    (["same", "other", "overview"] as const).map((selection) => ({ action, selection })),
  ),
)("attributes a failed $action after selecting $selection", async ({ action, selection }) => {
  const alpha = job("alpha");
  const beta = job("beta");
  const response = createDeferred<unknown>();
  const request = vi.fn(() => response.promise);
  const state = createInitialCronState({
    connected: true,
    client: { request } as unknown as CronState["client"],
  });
  state.cronJobs = [alpha, beta];
  startCronEdit(state, alpha);
  const mutation =
    action === "run"
      ? runCronJob(state, alpha.id)
      : action === "toggle"
        ? toggleCronJob(state, alpha, false)
        : removeCronJob(state, alpha);
  expect(state.cronBusy).toBe(true);
  expect(state.cronPendingAction).toBe(action);
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
  expect(state.cronPendingAction).toBeNull();
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

it("preserves queued run feedback when due-mode history refresh fails", async () => {
  const request = vi.fn(async (method: string, payload?: unknown) => {
    if (method === "cron.run") {
      expect(payload).toMatchObject({
        id: "job-due",
        mode: "due",
      });
      return { ok: true, enqueued: true, runId: "run-due" };
    }
    if (method === "cron.runs") {
      throw new Error("run history refresh unavailable");
    }
    return {};
  });
  const state = createStateWithRequest(request, {
    cronRunsScope: "job",
    cronRunsJobId: "job-due",
  });
  await runCronJob(state, "job-due", "due");

  expect(request).toHaveBeenCalledWith("cron.run", { id: "job-due", mode: "due" });
  expect(request).toHaveBeenCalledWith("cron.runs", expect.any(Object));
  expect(state.cronError).toBe("job-due: Run queued. Run ID: run-due");
});

it.each([
  ["not-due", "This automation is not due yet."],
  ["already-running", "This automation is already running."],
  ["restart-recovery-pending", "Scheduler recovery is still in progress."],
  ["stopped", "The scheduler is stopped."],
] as const)(
  "surfaces cron.run %s outcomes without reloading run history",
  async (reason, message) => {
    const request = vi.fn(async (method: string) => {
      if (method === "cron.run") {
        return { ok: true, ran: false, reason };
      }
      return {};
    });
    const state = createStateWithRequest(request, {
      cronRunsScope: "job",
      cronRunsJobId: "job-blocked",
    });

    await runCronJob(state, "job-blocked", "force");

    expect(state.cronError).toBe(`job-blocked: ${message}`);
    expect(request).toHaveBeenCalledWith("cron.run", { id: "job-blocked", mode: "force" });
    expect(request).not.toHaveBeenCalledWith("cron.runs", expect.anything());
  },
);

it("reloads the skipped run recorded for an invalid persisted specification", async () => {
  const responses: Record<string, unknown> = {
    "cron.run": { ok: true, ran: false, reason: "invalid-spec" },
    "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
  };
  const request = vi.fn(async (method: string) => responses[method] ?? {});
  const state = createStateWithRequest(request, {
    cronRunsScope: "job",
    cronRunsJobId: "job-invalid",
  });

  await runCronJob(state, "job-invalid", "force");

  expect(state.cronError).toBe("job-invalid: This automation has an invalid schedule or payload.");
  expect(request).toHaveBeenCalledWith("cron.runs", expect.objectContaining({ id: "job-invalid" }));
});

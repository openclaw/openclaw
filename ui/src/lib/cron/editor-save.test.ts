// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob } from "../../api/types.ts";
import { addCronJob, cancelCronEdit, createInitialCronState, startCronEdit } from "./index.ts";
import type { CronState } from "./types.ts";

function createCronJob(overrides: Pick<CronJob, "id" | "name">): CronJob {
  return {
    ...overrides,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    configRevision: "config-revision-1",
    schedule: { kind: "cron", expr: "0 * * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
  };
}

function cronJobsListResponse(jobs: CronJob[]) {
  return {
    jobs,
    snapshotRevision: "editor-jobs",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function createStateWithRequest(request: unknown, overrides: Partial<CronState>): CronState {
  return {
    ...createInitialCronState({ connected: true, client: { request } as CronState["client"] }),
    ...overrides,
  };
}

describe("automation save editor ownership", () => {
  it.each(["save", "conflict read", "conflict read failure"] as const)(
    "preserves a reopened editor when an earlier %s settles",
    async (pendingPhase) => {
      const job = createCronJob({ id: "reopened-job", name: "Saved definition" });
      const updated = { ...job, name: "Earlier save", configRevision: "earlier-save-revision" };
      const pending = createDeferred<CronJob>();
      const conflict = Object.assign(new Error("Definition changed"), {
        details: { code: "CRON_JOB_CHANGED" },
      });
      let exactReads = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "cron.update") {
          if (pendingPhase === "save") {
            return pending.promise;
          }
          throw conflict;
        }
        if (method === "cron.get") {
          exactReads += 1;
          // Conflict reconciliation first refreshes the selected runtime, then its definition.
          return exactReads === 1 ? job : pending.promise;
        }
        if (method === "cron.list") {
          return cronJobsListResponse([updated]);
        }
        return { enabled: true, jobs: 1 };
      });
      const state = createStateWithRequest(request, { cronJobs: [job] });
      startCronEdit(state, job);
      state.cronForm.name = updated.name;
      const save = addCronJob(state);
      if (pendingPhase !== "save") {
        await vi.waitFor(() => expect(exactReads).toBe(2));
      }
      cancelCronEdit(state, null);
      startCronEdit(state, job);
      state.cronForm.name = "Newer unsaved edit";
      state.cronError = "New editor feedback";
      const reopenedForm = state.cronForm;
      if (pendingPhase === "conflict read failure") {
        pending.reject(new Error("Earlier definition read failed"));
      } else {
        pending.resolve(updated);
      }
      await expect(save).resolves.toEqual(
        pendingPhase === "save" ? { saved: true, jobId: job.id } : { saved: false },
      );
      expect(state.cronEditingJob).toBe(job);
      expect(state.cronForm).toBe(reopenedForm);
      expect(state.cronForm.name).toBe("Newer unsaved edit");
      expect(state.cronEditingJob?.configRevision).toBe(job.configRevision);
      expect(state.cronError).toBe("New editor feedback");
      expect(state.cronBusy).toBe(false);
      expect(state.cronJobs).toEqual([updated]);
    },
  );
});

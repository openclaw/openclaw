import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM, DEFAULT_CRON_RUNTIME_RUNS_FILTERS } from "../app-defaults.ts";
import {
  addCronJob,
  applyCronRuntimeRunsPreset,
  loadOpsRuntimeRuns,
  normalizeCronFormState,
  type CronState,
} from "./cron.ts";

function createState(overrides: Partial<CronState> = {}): CronState {
  return {
    client: null,
    connected: true,
    cronLoading: false,
    cronJobs: [],
    cronStatus: null,
    cronError: null,
    cronForm: { ...DEFAULT_CRON_FORM },
    cronRunsJobId: null,
    cronRuns: [],
    cronRuntimeRunsLoading: false,
    cronRuntimeRunsError: null,
    cronRuntimeRunsFilters: { ...DEFAULT_CRON_RUNTIME_RUNS_FILTERS },
    cronRuntimeRuns: null,
    cronBusy: false,
    ...overrides,
  };
}

describe("cron controller", () => {
  it("normalizes stale announce mode when session/payload no longer support announce", () => {
    const normalized = normalizeCronFormState({
      ...DEFAULT_CRON_FORM,
      sessionTarget: "main",
      payloadKind: "systemEvent",
      deliveryMode: "announce",
    });

    expect(normalized.deliveryMode).toBe("none");
  });

  it("keeps announce mode when isolated agentTurn supports announce", () => {
    const normalized = normalizeCronFormState({
      ...DEFAULT_CRON_FORM,
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      deliveryMode: "announce",
    });

    expect(normalized.deliveryMode).toBe("announce");
  });

  it("forwards webhook delivery in cron.add payload", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-1" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "webhook job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "run this",
        deliveryMode: "webhook",
        deliveryTo: "https://example.invalid/cron",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall).toBeDefined();
    expect(addCall?.[1]).toMatchObject({
      name: "webhook job",
      delivery: { mode: "webhook", to: "https://example.invalid/cron" },
    });
  });

  it("does not submit stale announce delivery when unsupported", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-2" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "main job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payloadKind: "systemEvent",
        payloadText: "run this",
        deliveryMode: "announce",
        deliveryTo: "buddy",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall).toBeDefined();
    expect(addCall?.[1]).toMatchObject({
      name: "main job",
    });
    expect((addCall?.[1] as { delivery?: unknown } | undefined)?.delivery).toBeUndefined();
    expect(state.cronForm.deliveryMode).toBe("none");
  });

  it("loads ops runtime runs with filters", async () => {
    const request = vi.fn(async (method: string, payload?: Record<string, unknown>) => {
      if (method === "ops.runtime.runs") {
        expect(payload?.status).toBe("error");
        expect(payload?.search).toBe("failover");
        expect(typeof payload?.fromMs).toBe("number");
        expect(typeof payload?.toMs).toBe("number");
        return {
          ts: Date.now(),
          summary: {
            jobsScanned: 1,
            jobsTotal: 1,
            jobsTruncated: false,
            totalRuns: 1,
            okRuns: 0,
            errorRuns: 1,
            skippedRuns: 0,
            timeoutRuns: 1,
            jobsWithFailures: 1,
            needsAction: 1,
          },
          runs: [
            {
              ts: Date.now(),
              ageMs: 0,
              jobId: "job-1",
              jobName: "job-1",
              enabled: true,
              status: "error",
              logPath: "runs/job-1.jsonl",
            },
          ],
          failures: [
            {
              jobId: "job-1",
              jobName: "job-1",
              enabled: true,
              totalRuns: 1,
              errors: 1,
              timeoutErrors: 1,
              consecutiveErrors: 2,
              needsAction: true,
              logPath: "runs/job-1.jsonl",
            },
          ],
        };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronRuntimeRunsFilters: {
        ...DEFAULT_CRON_RUNTIME_RUNS_FILTERS,
        search: "failover",
        status: "error",
        fromLocal: "2026-02-20T09:00",
        toLocal: "2026-02-20T18:00",
      },
    });

    await loadOpsRuntimeRuns(state);
    expect(state.cronRuntimeRunsError).toBeNull();
    expect(state.cronRuntimeRuns?.summary.errorRuns).toBe(1);
    expect(state.cronRuntimeRuns?.runs.length).toBe(1);
  });

  it("applies runtime range presets", () => {
    const state = createState();
    applyCronRuntimeRunsPreset(state, "24h");
    expect(state.cronRuntimeRunsFilters.fromLocal.length).toBeGreaterThan(0);
    expect(state.cronRuntimeRunsFilters.toLocal.length).toBeGreaterThan(0);

    applyCronRuntimeRunsPreset(state, "clear");
    expect(state.cronRuntimeRunsFilters.fromLocal).toBe("");
    expect(state.cronRuntimeRunsFilters.toLocal).toBe("");
  });
});

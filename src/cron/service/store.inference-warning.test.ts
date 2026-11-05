import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { describeCronInferenceMigration } from "../../gateway/server-cron-inference.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CronService } from "../service.js";
import { loadCronJobsStore, saveCronJobsStore } from "../store.js";
import type { CronStoredJob } from "../types.js";

const NOW_MS = Date.parse("2026-11-01T12:00:00.000Z");
const PAST_AT = "2026-11-01T11:00:00.000Z";
const FUTURE_AT = "2026-11-01T13:00:00.000Z";

const cfg: OpenClawConfig = {
  agents: {
    entries: { main: {} },
    defaults: {
      systemAgent: { agentId: "main" },
      model: "openai/gpt-5.5",
      subagents: { model: { primary: "openai/gpt-5.5" } },
      models: { "anthropic/*": { agentRuntime: { id: "claude-cli" } } },
    },
  },
  models: {
    providers: { ollama: { api: "ollama", baseUrl: "http://127.0.0.1:11434", models: [] } },
  },
};

const recurring: CronStoredJob = {
  id: "remote",
  name: "Remote inherited model",
  agentId: "main",
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Synthetic work" },
  state: { nextRunAtMs: Date.parse(FUTURE_AT) },
};
const paused: CronStoredJob = { ...recurring, id: "paused", enabled: false, state: {} };
// Persisted shape of a one-shot after its successful automatic run.
const completedOneShot: CronStoredJob = {
  ...recurring,
  id: "completed",
  enabled: false,
  schedule: { kind: "at", at: PAST_AT },
  state: {
    lastRunAtMs: Date.parse(PAST_AT),
    lastRunStatus: "ok",
    lastStatus: "ok",
    lastDelivered: true,
    lastDeliveryStatus: "delivered",
  },
};

async function withLoadedCron(
  jobs: CronStoredJob[],
  run: (params: {
    cron: CronService;
    storePath: string;
    before: CronStoredJob[];
    warnedJobIds: () => string[];
    warn: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-inference-readiness" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs });
    const before = (await loadCronJobsStore(storePath)).jobs;
    const warn = vi.fn();
    const execute = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => NOW_MS,
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: { warn, error: vi.fn(), debug: vi.fn(), info: vi.fn() },
      enqueueSystemEvent() {},
      runIsolatedAgentJob: execute,
      describeJobReadinessWarning: (job) => describeCronInferenceMigration(cfg, job),
    });
    const warnedJobIds = () =>
      warn.mock.calls
        .filter(
          ([, message]) =>
            typeof message === "string" && message.includes("recorded inference account"),
        )
        .map(([fields]) => (fields as { jobId: string }).jobId);
    try {
      await cron.list({ includeDisabled: true });
      await run({ cron, storePath, before, warnedJobIds, warn, execute });
    } finally {
      cron.stop();
    }
  });
}

it("warns once from loaded legacy state before dispatch, without rewriting jobs or warning on known local/native routes", async () => {
  const local: CronStoredJob = {
    ...recurring,
    id: "local",
    payload: { kind: "agentTurn", message: "Local", model: "ollama/llama3.3" },
  };
  const native: CronStoredJob = {
    ...recurring,
    id: "native",
    payload: { kind: "agentTurn", message: "Native", model: "anthropic/claude-opus-4-6" },
  };
  await withLoadedCron(
    [recurring, local, native],
    async ({ cron, storePath, before, warnedJobIds, warn, execute }) => {
      await cron.list({ includeDisabled: true });
      expect(warnedJobIds()).toEqual(["remote"]);
      expect(warn).toHaveBeenCalledWith(
        { jobId: "remote", name: "Remote inherited model" },
        expect.stringContaining("openclaw doctor --fix"),
      );
      expect(execute).not.toHaveBeenCalled();
      expect((await loadCronJobsStore(storePath)).jobs).toEqual(before);
    },
  );
});

it("warns for enabled jobs with a retry, next_check slot or event source", async () => {
  const retrying: CronStoredJob = {
    ...completedOneShot,
    id: "retrying",
    enabled: true,
    state: { lastRunAtMs: Date.parse(PAST_AT), lastRunStatus: "error", lastStatus: "error" },
  };
  const nextCheck: CronStoredJob = {
    ...completedOneShot,
    id: "next-check",
    enabled: true,
    state: { ...completedOneShot.state, nextRunAtMs: Date.parse(FUTURE_AT) },
  };
  const onExit: CronStoredJob = {
    ...recurring,
    id: "on-exit",
    schedule: { kind: "on-exit", command: "./watch.sh" },
    state: {},
  };
  await withLoadedCron([retrying, nextCheck, onExit], async ({ warnedJobIds }) => {
    expect(warnedJobIds()).toEqual(["retrying", "next-check", "on-exit"]);
  });
});

it("does not warn on startup for jobs that cannot run", async () => {
  const enabledButSpent: CronStoredJob = { ...completedOneShot, id: "spent", enabled: true };
  const cronJob = (id: string, expr: string): CronStoredJob => ({
    ...recurring,
    id,
    schedule: { kind: "cron", expr },
    state: {},
  });
  await withLoadedCron(
    [
      completedOneShot,
      paused,
      enabledButSpent,
      cronJob("never-fires", "0 0 30 2 *"),
      cronJob("malformed", "not a cron expression"),
    ],
    async ({ warnedJobIds }) => {
      expect(warnedJobIds()).toEqual([]);
    },
  );
});

it("warns when an edit gives a job another run, and not before", async () => {
  await withLoadedCron([completedOneShot, paused], async ({ cron, warnedJobIds }) => {
    await cron.update("paused", { name: "Still paused" });
    await cron.update("completed", { enabled: true });
    expect(warnedJobIds()).toEqual([]);

    await cron.update("paused", { enabled: true });
    expect(warnedJobIds()).toEqual(["paused"]);

    await cron.update("completed", { schedule: { kind: "at", at: FUTURE_AT } });
    expect(warnedJobIds()).toEqual(["paused", "completed"]);

    await cron.update("paused", { name: "Running again" });
    expect(warnedJobIds()).toEqual(["paused", "completed"]);
  });
});

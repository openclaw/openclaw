import { afterEach, expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCronInferenceMigrationDiagnostic } from "../../gateway/server-cron-inference.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as modelSelection from "../isolated-agent/model-selection.js";
import { CronService } from "../service.js";
import { loadCronJobsStore, saveCronJobsStore } from "../store.js";
import type { CronStoredJob } from "../types.js";

const model = "anthropic/claude-opus-4-6";
const cfg: OpenClawConfig = {
  agents: {
    entries: { main: {} },
    defaults: {
      systemAgent: { agentId: "main" },
      model,
      models: {
        "anthropic/*": { agentRuntime: { id: "claude-cli" } },
      },
    },
  },
};
const job = (id: string): CronStoredJob => ({
  id,
  name: id,
  agentId: "main",
  enabled: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 60000 },
  sessionTarget: "main",
  wakeMode: "now",
  payload: { kind: "systemEvent", text: "Reminder" },
  delivery: { mode: "none" },
  state: {},
});
function service(storePath: string) {
  const clock = createGatewaySchedulerClock();
  const warn = vi.fn();
  const describe = vi.fn(createCronInferenceMigrationDiagnostic(() => cfg));
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath,
    cronEnabled: false,
    defaultAgentId: "main",
    log: { warn, error: vi.fn(), debug: vi.fn(), info: vi.fn() },
    enqueueSystemEvent() {},
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    describeJobLoadWarning: describe,
  });
  return { clock, warn, describe, cron };
}
afterEach(() => vi.restoreAllMocks());

it("warns only for a legacy reminder needing an account", async () => {
  await withOpenClawTestState({ label: "cron-inference-startup" }, async (state) => {
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await persistAuthProfileBatch({
      profiles: [
        {
          profileId: "anthropic:token",
          credential: { type: "token", provider: "anthropic", token: "synthetic-token" },
        },
      ],
    });
    const jobs: CronStoredJob[] = [
      job("legacy"),
      { ...job("new"), systemEventAccount: "session" },
      {
        ...job("live"),
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Check" },
      },
    ];
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs });
    const { cron, clock, warn } = service(storePath);
    try {
      await cron.list({ includeDisabled: true });
      await clock.advanceBy(0);
      expect(warn.mock.calls).toEqual([
        [{ jobId: "legacy", name: "legacy" }, expect.stringContaining("openclaw doctor --fix")],
      ]);
      expect((await loadCronJobsStore(storePath)).jobs).toEqual(jobs);
    } finally {
      cron.stop();
    }
  });
});

it.each(["budget", "stop"])(
  "%s keeps cron load/list free and stops the active diagnostic before more preparation",
  async (cutoff) => {
    await withOpenClawTestState({ label: "cron-diagnostic-cutoff" }, async (state) => {
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const jobs: CronStoredJob[] = [job("slow"), job("unchecked")];
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, { version: 1, jobs });
      const pending = createDeferredCore();
      const started = createDeferredCore();
      // Hold the real session read, so expiry must prevent the diagnostic's next owner operation.
      const read = sessionReads.readSessionEntriesFromStoreInWorker;
      vi.spyOn(sessionReads, "readSessionEntriesFromStoreInWorker").mockImplementationOnce(
        async (params) => {
          started.resolve();
          await pending.promise;
          return read(params);
        },
      );
      const prepareModel = vi.spyOn(modelSelection, "resolveCronModelSelection");
      const { cron, clock, warn, describe } = service(storePath);
      const loading = cron.list({ includeDisabled: true });
      try {
        expect(
          await Promise.race([
            loading.then(() => "loaded"),
            started.promise.then(() => "diagnostic"),
          ]),
        ).toBe("loaded");
        const scan = clock.advanceBy(0);
        await started.promise;
        expect(await cron.list({ includeDisabled: true })).toHaveLength(2);
        if (cutoff === "stop") {
          cron.stop();
        } else {
          await clock.advanceBy(5000);
        }
        await scan;
        pending.resolve();
        await pending.promise;
        // Wait for the actual diagnostic, not only the scheduler's outer race.
        await describe.mock.results[0]!.value;
        expect(prepareModel).not.toHaveBeenCalled();
        expect(describe).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls).toEqual(
          cutoff === "stop"
            ? []
            : [[{ uncheckedJobs: 2 }, expect.stringContaining("openclaw doctor --lint")]],
        );
      } finally {
        pending.resolve();
        await loading;
        cron.stop();
      }
    });
  },
);

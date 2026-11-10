import { afterEach, expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { createTestModelDefinition } from "../../commands/test-runtime-config-helpers.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
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
      models: { "anthropic/*": { agentRuntime: { id: "claude-cli" } } },
      modelPolicy: { allow: ["anthropic/*", "remote/model", "profile-key/model"] },
    },
  },
  models: {
    providers: {
      remote: {
        api: "openai-completions",
        auth: "api-key",
        apiKey: "synthetic-direct-key",
        baseUrl: "https://remote.invalid.test/v1",
        models: [createTestModelDefinition("model")],
      },
    },
  },
};
cfg.models!.providers!["profile-key"] = {
  ...cfg.models!.providers!.remote!,
  apiKey: "profile-key:stored",
};
const job = (id: string, selectedModel = model): CronStoredJob => ({
  id,
  name: id,
  agentId: "main",
  enabled: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 60000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Synthetic work", model: selectedModel },
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

it("inspects stored CLI and selected configured-key sources once without rewriting jobs", async () => {
  await withOpenClawTestState({ label: "cron-inference-startup" }, async (state) => {
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await persistAuthProfileBatch({
      profiles: [
        {
          profileId: "anthropic:token",
          credential: { type: "token", provider: "anthropic", token: "synthetic-token" },
        },
        {
          profileId: "profile-key:stored",
          credential: { type: "api_key", provider: "profile-key", key: "synthetic-stored-key" },
        },
      ],
    });
    const jobs = [
      job("stored"),
      job("native", `${model}@anthropic:claude-cli`),
      job("key", "remote/model"),
      job("profile-key", "profile-key/model"),
    ];
    for (const id of ["pinned-key", "locked-native"]) {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: `agent:main:${id}` },
        {
          sessionId: id,
          updatedAt: 1,
          authProfileOverride: "anthropic:token",
          authProfileOverrideSource: "user",
          ...(id === "locked-native"
            ? { modelSelectionLocked: true, agentRuntimeOverride: "claude-cli" }
            : {}),
        },
      );
      jobs.push({
        ...job(id, id === "pinned-key" ? "remote/model" : model),
        sessionTarget: `session:agent:main:${id}`,
      });
    }
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs });
    const { cron, clock, warn, describe } = service(storePath);
    try {
      await cron.list({ includeDisabled: true });
      await clock.advanceBy(0);
      await cron.list({ includeDisabled: true });
      expect(describe).toHaveBeenCalledTimes(jobs.length);
      expect(warn.mock.calls).toEqual([
        [
          { jobId: "stored", name: "stored" },
          expect.stringContaining(
            `openclaw automations edit stored --model ${model}@anthropic:token`,
          ),
        ],
        [
          { jobId: "profile-key", name: "profile-key" },
          expect.stringContaining("openclaw doctor --fix"),
        ],
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
      const jobs: CronStoredJob[] = [
        { ...job("slow"), sessionTarget: "session:agent:main:slow" },
        job("unchecked"),
      ];
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

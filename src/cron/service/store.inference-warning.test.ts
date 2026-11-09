import { expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { createTestModelDefinition } from "../../commands/test-runtime-config-helpers.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { describeCronInferenceMigration } from "../../gateway/server-cron-inference.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CronService } from "../service.js";
import { loadCronJobsStore, saveCronJobsStore } from "../store.js";
import type { CronStoredJob } from "../types.js";

it.each([false, true])(
  "warns once from background inspection without rewriting jobs or warning on known local/native routes (stored CLI account: %s)",
  async (stored) => {
    await withOpenClawTestState({ label: "cron-inference-startup" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: {
            systemAgent: { agentId: "main" },
            model: "openai/gpt-5.5",
            subagents: { model: { primary: "openai/gpt-5.5" } },
            models: { "anthropic/*": { agentRuntime: { id: "claude-cli" } } },
            modelPolicy: {
              allow: [
                "openai/gpt-5.5",
                "anthropic/*",
                "ollama/llama3.3",
                "remote/model",
                "profile-key/model",
              ],
            },
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [createTestModelDefinition("llama3.3")],
            },
          },
        },
      };
      await persistAuthProfileBatch({
        profiles: [
          {
            profileId: "openai:default",
            credential: { type: "api_key", provider: "openai", key: "synthetic-openai-key" },
          },
          {
            profileId: "profile-key:stored",
            credential: { type: "api_key", provider: "profile-key", key: "synthetic-profile-key" },
          },
        ],
      });
      if (stored) {
        await persistAuthProfileBatch({
          profiles: [
            {
              profileId: "anthropic:default",
              credential: { type: "token", provider: "anthropic", token: "synthetic-token" },
            },
          ],
        });
      }
      cfg.models!.providers!.remote = {
        api: "openai-completions",
        auth: "api-key",
        apiKey: "synthetic-direct-key",
        baseUrl: "https://remote.invalid.test/v1",
        models: [createTestModelDefinition("model")],
      };
      cfg.models!.providers!["profile-key"] = {
        ...cfg.models!.providers!.remote!,
        apiKey: "profile-key:stored",
      };
      const base: CronStoredJob = {
        id: "remote",
        name: "Remote inherited model",
        agentId: "main",
        enabled: false,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Synthetic work" },
        state: {},
      };
      const local: CronStoredJob = {
        ...base,
        id: "local",
        payload: { ...base.payload, kind: "agentTurn", message: "Local", model: "ollama/llama3.3" },
      };
      const native: CronStoredJob = {
        ...base,
        id: "native",
        payload: { kind: "agentTurn", message: "Native", model: "anthropic/claude-opus-4-6" },
      };
      const configuredKey: CronStoredJob = {
        ...base,
        id: "configured-key",
        payload: { kind: "agentTurn", message: "Configured", model: "remote/model" },
      };
      const profileKey: CronStoredJob = {
        ...configuredKey,
        id: "profile-key",
        payload: {
          kind: "agentTurn",
          message: "Stored profile reference",
          model: "profile-key/model",
        },
      };
      const explicitNative: CronStoredJob = {
        ...native,
        id: "explicit-native",
        payload: {
          kind: "agentTurn",
          message: "Native login",
          model: "anthropic/claude-opus-4-6@anthropic:claude-cli",
        },
      };
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: [base, local, native, configuredKey, explicitNative, profileKey],
      });
      const before = (await loadCronJobsStore(storePath)).jobs;
      const warn = vi.fn();
      const execute = vi.fn(async () => ({ status: "ok" as const }));
      const clock = createGatewaySchedulerClock();
      const describe = vi.fn((job: CronStoredJob) => describeCronInferenceMigration(cfg, job));
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(clock.clock),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: { warn, error: vi.fn(), debug: vi.fn(), info: vi.fn() },
        enqueueSystemEvent() {},
        runIsolatedAgentJob: execute,
        describeJobLoadWarning: describe,
      });
      try {
        await cron.list({ includeDisabled: true });
        await clock.advanceBy(0);
        await cron.list({ includeDisabled: true });
        expect(describe).toHaveBeenCalledTimes(6);
        expect(
          warn.mock.calls.filter(
            ([, message]) => typeof message === "string" && message.includes("inference account"),
          ),
        ).toEqual([
          [
            { jobId: "remote", name: "Remote inherited model" },
            expect.stringContaining("openclaw doctor --fix"),
          ],
          ...(stored
            ? [
                [
                  { jobId: "native", name: "Remote inherited model" },
                  expect.stringContaining(
                    "openclaw automations edit native --model anthropic/claude-opus-4-6@anthropic:default",
                  ),
                ],
              ]
            : []),
          [
            { jobId: "profile-key", name: "Remote inherited model" },
            expect.stringContaining("openclaw doctor --fix"),
          ],
        ]);
        expect(execute).not.toHaveBeenCalled();
        expect((await loadCronJobsStore(storePath)).jobs).toEqual(before);
      } finally {
        cron.stop();
      }
    });
  },
);

it.each(["native-default", "stored-default", "pinned-native"] as const)(
  "startup matches the CLI account used by %s",
  async (scenario) => {
    await withOpenClawTestState({ label: "cron-cli-selection" }, async (state) => {
      const model = "anthropic/claude-opus-4-6";
      const profile =
        scenario === "native-default"
          ? "anthropic:claude-cli"
          : scenario === "stored-default"
            ? "anthropic:work"
            : undefined;
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: {
            systemAgent: { agentId: "main" },
            model: profile ? `${model}@${profile}` : model,
            models: { "anthropic/*": { agentRuntime: { id: "claude-cli" } } },
          },
        },
        session: { reset: { mode: "idle", idleMinutes: 1 } },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      await persistAuthProfileBatch({
        profiles: [
          ...(scenario === "stored-default"
            ? []
            : [
                {
                  profileId: "anthropic:token",
                  credential: {
                    type: "token" as const,
                    provider: "anthropic",
                    token: "synthetic-token",
                  },
                },
              ]),
          {
            profileId: "anthropic:work",
            credential: { type: "api_key", provider: "anthropic", key: "synthetic-work-key" },
          },
        ],
      });
      const sessionKey = "agent:main:idle-native";
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "idle-native",
          updatedAt: 1,
          cliSessionBindings: { "claude-cli": { sessionId: "native-resume" } },
        },
      );
      const job: CronStoredJob = {
        id: scenario,
        name: scenario,
        agentId: "main",
        enabled: false,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60000 },
        wakeMode: "now",
        sessionTarget: scenario === "pinned-native" ? `session:${sessionKey}` : "isolated",
        payload: { kind: "agentTurn", message: "Synthetic work", model },
        delivery: { mode: "none" },
        state: {},
      };
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
      const clock = createGatewaySchedulerClock();
      const warn = vi.fn();
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(clock.clock),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: { warn, error: vi.fn(), debug: vi.fn(), info: vi.fn() },
        enqueueSystemEvent() {},
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        describeJobLoadWarning: (loaded) => describeCronInferenceMigration(cfg, loaded),
      });
      try {
        await cron.list({ includeDisabled: true });
        await clock.advanceBy(0);
        const warnings = warn.mock.calls.filter(
          ([, message]) => typeof message === "string" && message.includes("inference account"),
        );
        if (scenario === "stored-default") {
          expect(warnings).toEqual([
            [
              { jobId: scenario, name: scenario },
              expect.stringContaining(`${model}@anthropic:work`),
            ],
          ]);
        } else {
          expect(warnings).toEqual([]);
        }
        expect((await loadCronJobsStore(storePath)).jobs).toEqual([job]);
      } finally {
        cron.stop();
      }
    });
  },
);

it("keeps cron load and list independent of a slow diagnostic and bounds the whole scan once", async () => {
  await withOpenClawTestState({ label: "cron-diagnostic-budget" }, async (state) => {
    const job: CronStoredJob = {
      id: "slow",
      name: "Slow",
      agentId: "main",
      enabled: false,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Synthetic work" },
      delivery: { mode: "none" },
      state: {},
    };
    const jobs = [job, { ...job, id: "unchecked" }];
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs });
    const clock = createGatewaySchedulerClock();
    const pending = createDeferredCore<string | undefined>();
    const started = createDeferredCore();
    const describe = vi.fn(() => {
      started.resolve();
      return pending.promise;
    });
    const warn = vi.fn();
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
      await clock.advanceBy(5000);
      await scan;
      expect(warn).toHaveBeenCalledWith(
        { uncheckedJobs: 2 },
        expect.stringContaining("openclaw doctor --lint"),
      );
      pending.resolve("late warning");
      await pending.promise;
      await clock.advanceBy(5000);
      expect(describe).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect((await loadCronJobsStore(storePath)).jobs).toEqual(jobs);
    } finally {
      pending.resolve(undefined);
      await loading;
      cron.stop();
    }
  });
});

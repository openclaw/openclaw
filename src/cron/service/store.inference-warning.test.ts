import { expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { createTestModelDefinition } from "../../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { describeCronInferenceMigration } from "../../gateway/server-cron-inference.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CronService } from "../service.js";
import { loadCronJobsStore, saveCronJobsStore } from "../store.js";
import type { CronStoredJob } from "../types.js";

it.each([false, true])(
  "warns once from loaded legacy state before dispatch, without rewriting jobs or warning on known local/native routes (stored CLI account: %s)",
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
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: { warn, error: vi.fn(), debug: vi.fn(), info: vi.fn() },
        enqueueSystemEvent() {},
        runIsolatedAgentJob: execute,
        describeJobLoadWarning: (job) => describeCronInferenceMigration(cfg, job),
      });
      try {
        await cron.list({ includeDisabled: true });
        await cron.list({ includeDisabled: true });
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

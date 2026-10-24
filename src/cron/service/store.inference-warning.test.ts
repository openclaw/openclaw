import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { describeCronInferenceMigration } from "../../gateway/server-cron-inference.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CronService } from "../service.js";
import { loadCronJobsStore, saveCronJobsStore } from "../store.js";
import type { CronStoredJob } from "../types.js";

it("warns once from loaded legacy state before dispatch, without rewriting jobs or warning on known local/native routes", async () => {
  await withOpenClawTestState({ label: "cron-inference-startup" }, async (state) => {
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
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs: [base, local, native] });
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
          ([, message]) =>
            typeof message === "string" && message.includes("recorded inference account"),
        ),
      ).toEqual([
        [
          { jobId: "remote", name: "Remote inherited model" },
          expect.stringContaining("openclaw doctor --fix"),
        ],
      ]);
      expect(execute).not.toHaveBeenCalled();
      expect((await loadCronJobsStore(storePath)).jobs).toEqual(before);
    } finally {
      cron.stop();
    }
  });
});

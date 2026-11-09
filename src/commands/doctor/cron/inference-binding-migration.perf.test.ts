import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../../../agents/auth-profiles/upsert-with-lock.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import type { CronStoredJob } from "../../../cron/types.js";
import { cronInferenceCheck } from "../../../flows/doctor-cron-checks.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import { PluginLoaderCacheState } from "../../../plugins/loader-cache-state.js";
import { createNonExitingRuntime } from "../../../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { withDoctorConfigMaintenance } from "../../doctor-config-flow.test-support.js";
import { snapshotDoctorLintSqliteFamily } from "../../doctor-lint.test-support.js";
import { maybeRepairCronInferenceBindings } from "./inference-binding-migration.js";

afterEach(() => vi.restoreAllMocks());

it("prepares one agent snapshot for several unbound jobs and preserves lint findings and source bytes", async () => {
  await withOpenClawTestState(
    {
      label: "doctor-cron-snapshots",
      env: { OPENAI_API_KEY: undefined, OPENCLAW_LOG_LEVEL: "debug" },
    },
    async (state) => {
      const logPath = state.path("inspection.log");
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: { model: "openai/gpt-5.4" },
        },
        plugins: { allow: ["openai"], slots: { memory: "none" } },
        logging: { level: "debug", file: logPath },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      resetLogger();
      await persistAuthProfileBatch({
        profiles: [
          {
            profileId: "openai:default",
            credential: { type: "api_key", provider: "openai", key: "synthetic-key" },
          },
        ],
      });
      const jobs: CronStoredJob[] = Array.from({ length: 4 }, (_, i) => ({
        id: `job-${i}`,
        name: `Job ${i}`,
        agentId: "main",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Synthetic work" },
        delivery: { mode: "none" },
        state: {},
      }));
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, { version: 1, jobs });
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:cron:job-0" },
        {
          sessionId: "synthetic-session",
          updatedAt: 1,
          providerOverride: "openai",
          modelOverride: "gpt-5.5",
          modelOverrideSource: "user",
        },
      );
      await closeOpenClawAgentDatabasesAsync();
      const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const before = snapshotDoctorLintSqliteFamily(agentPath);
      await flushLogger();
      fs.writeFileSync(logPath, "");
      try {
        const findings = await withOpenClawStateDatabaseReadSnapshot(() =>
          cronInferenceCheck.detect({ cfg, mode: "lint", runtime: createNonExitingRuntime() }),
        );
        expect(findings).toHaveLength(jobs.length);
        for (const job of jobs) {
          expect(findings).toContainEqual(
            expect.objectContaining({
              severity: "warning",
              requirement: "cron-inference-account",
              message: expect.stringContaining(
                `Automation ${job.name} (${job.id}): retain openai:default for openai/${job.id === "job-0" ? "gpt-5.5" : "gpt-5.4"}`,
              ),
            }),
          );
        }
        expect(snapshotDoctorLintSqliteFamily(agentPath)).toEqual(before);
        await flushLogger();
        const preparations = fs
          .readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.includes(`SQLite read-only snapshot for ${agentPath}:`));
        expect(preparations).toHaveLength(1);
      } finally {
        resetLogger();
      }
    },
  );
});

it("shares runtime preparation across mixed-provider cron repairs without changing bindings", async () => {
  await withOpenClawTestState(
    {
      label: "doctor-cron-scale",
      env: {
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
      },
    },
    async (state) => {
      const count = Number(process.env.BENCH_AGENTS ?? 8);
      const providers = ["openai", "anthropic", "openrouter"];
      const models = ["gpt-5.4", "claude-sonnet-4-5", "anthropic/claude-sonnet-4.5"];
      const entries = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `agent-${i}`,
          {
            agentDir: state.agentDir(`agent-${i}`),
            workspace: state.path(`workspace-${i}`),
            model: { primary: `${providers[i % 3]}/${models[i % 3]}` },
          },
        ]),
      );
      const cfg: OpenClawConfig = {
        agents: { entries, defaults: { model: "openai/gpt-5.4" } },
        plugins: { allow: providers, slots: { memory: "none" } },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      await persistAuthProfileBatch({
        profiles: providers.map((provider) => ({
          profileId: `${provider}:default`,
          credential: { type: "api_key", provider, key: "synthetic-offline-key" },
        })),
      });
      const jobs: CronStoredJob[] = Array.from({ length: count }, (_, i) => ({
        id: `job-${i}`,
        name: `Synthetic job ${i}`,
        agentId: `agent-${i}`,
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Synthetic tool-bearing work" },
        delivery: { mode: "none" },
        state: {},
      }));
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, { version: 1, jobs });
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline proof"));
      const load = vi.spyOn(PluginLoaderCacheState.prototype, "beginLoad");
      const clone = globalThis.structuredClone;
      let configClones = 0;
      vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
        if (value && typeof value === "object" && "agents" in value && "plugins" in value) {
          configClones++;
        }
        return clone(value, options);
      });
      const result = await withDoctorConfigMaintenance(() =>
        maybeRepairCronInferenceBindings({ cfg, shouldRepair: true }),
      );
      const repaired = (await loadCronJobsStore(storePath)).jobs;
      expect(result.warnings).toEqual([]);
      expect(repaired).toEqual(
        jobs.map((job, i) =>
          Object.assign({}, job, {
            inferenceBinding: {
              version: 1,
              provider: providers[i % 3],
              profileId: `${providers[i % 3]}:default`,
              authorizationId: expect.any(String),
              authRequirement: "api-key",
              source: "auto",
            },
          }),
        ),
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(configClones).toBeLessThanOrEqual(providers.length * 4);
      expect(load.mock.calls.length).toBeLessThanOrEqual(providers.length * 2);
    },
  );
});

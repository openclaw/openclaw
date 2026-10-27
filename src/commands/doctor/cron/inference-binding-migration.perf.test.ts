import { afterEach, expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../../../agents/auth-profiles/upsert-with-lock.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import type { CronStoredJob } from "../../../cron/types.js";
import { PluginLoaderCacheState } from "../../../plugins/loader-cache-state.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { withDoctorConfigMaintenance } from "../../doctor-config-flow.test-support.js";
import { maybeRepairCronInferenceBindings } from "./inference-binding-migration.js";

afterEach(() => vi.restoreAllMocks());

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

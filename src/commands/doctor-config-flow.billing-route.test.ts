import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import { createModelAuthAvailabilityResolver } from "../agents/model-auth-availability.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronJobsStore, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "../flows/doctor-health-contribution-runners.config.js";
import { createUpdatePostInstallDoctorResultPath } from "../infra/update-doctor-result.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../infra/update-run-report.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { collectModelBillingRouteMigrationWarnings } from "./doctor/shared/model-billing-route-migration.js";
import { createTestModelDefinition } from "./test-runtime-config-helpers.js";

const withDoctorConfigPreflightHome = useDoctorConfigPreflightHome("billing-route");
const retirementStep = "finalize:doctor:model-retirement";

afterEach(() => closeOpenClawStateDatabaseForTest());

async function expectInheritedHeartbeatAutomation(config: OpenClawConfig) {
  const { jobs } = await loadCronJobsStore(resolveCronJobsStorePathFromConfig(config));
  const mainJobs = jobs.filter((job) => job.agentId === "main");
  expect(mainJobs).toHaveLength(1);
  expect(mainJobs[0]).toMatchObject({ payload: { kind: "agentTurn" } });
  expect(mainJobs[0]?.payload).not.toHaveProperty("model");
  expect(config.agents?.defaults).not.toHaveProperty("heartbeat");
  expect(config.agents?.entries?.main).not.toHaveProperty("heartbeat");
  return mainJobs[0]!;
}

async function writeBillingFixture(
  home: string,
  retiredModel: string,
  agents: OpenClawConfig["agents"],
) {
  const profiles = {
    "openai:default": { type: "api_key", provider: "openai", key: "synthetic-api-key" },
    "openai:chatgpt-default": {
      type: "oauth",
      provider: "openai",
      access: "synthetic-oauth-access",
      refresh: "synthetic-oauth-refresh",
      expires: Date.now() + 3_600_000,
    },
  };
  const config: OpenClawConfig = {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          models: [createTestModelDefinition(retiredModel, { name: "Heartbeat" })],
        },
      },
    },
    agents,
    gateway: { mode: "local" },
  };
  const configPath = await writeOpenClawConfig(home, config);
  const agentDir = path.join(path.dirname(configPath), "agents", "main", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({ version: 1, profiles }),
  );
  return { configPath, agentDir, config };
}

function billingDefaults(model: string, retired: string) {
  return {
    model: `openai/${model}`,
    models: { [`openai/${model}`]: { agentRuntime: { id: "codex" as const } } },
    heartbeat: { model: `openai/${retired}` },
  };
}

it("does not compare Decision selectors through conversational billing routes", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const { config: before, configPath } = await writeBillingFixture(home, "gpt-4o-mini", {
      defaults: billingDefaults("gpt-5.4", "gpt-4o-mini"),
      entries: { main: { decisionModel: "openai/gpt-4o-mini" } },
    });
    const after: OpenClawConfig = {
      ...before,
      agents: { ...before.agents, entries: { main: { decisionModel: "openai/gpt-5.6-luna" } } },
    };
    await using ctx = await prepareDoctorContext(configPath);
    expect(ctx.sourceConfigValid).toBe(true);
    expect(collectModelBillingRouteMigrationWarnings({ before, after })).toEqual([]);
    const withChatSelection = (config: OpenClawConfig, model: string): OpenClawConfig => ({
      ...config,
      agents: {
        ...config.agents,
        entries: { main: { ...config.agents?.entries?.main, model } },
      },
    });
    const warnings = collectModelBillingRouteMigrationWarnings({
      before: withChatSelection(before, "openai/gpt-4o-mini"),
      after: withChatSelection(after, "openai/gpt-5.6-luna"),
    });
    expect(warnings).toEqual(
      ["model.primary", "subagents.model"].map((selector) =>
        expect.stringContaining(
          `Billing route changed for agents.entries.main.${selector} (agent main):`,
        ),
      ),
    );
  });
});

it.each([false, true])(
  "preserves served utility models without changing billing (multiagent: %s)",
  async (multiagent) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const { configPath } = await writeBillingFixture(home, "gpt-4o-mini", {
        defaults: {
          ...billingDefaults("gpt-5.4", "gpt-4o-mini"),
          modelPolicy: { allow: ["openai/gpt-5.4", "openai/gpt-4o-mini"] },
          subagents: { model: "openai/gpt-4o-mini" },
        },
        ...(multiagent ? { ownership: "explicit" } : {}),
        entries: multiagent
          ? {
              main: { heartbeat: {} },
              metered: {
                heartbeat: { model: "openai/gpt-5.4" },
                subagents: { model: "openai/gpt-5.4" },
                models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
              },
            }
          : { main: {} },
      });
      {
        await using ctx = await prepareDoctorContext(configPath);
        await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
        expect(ctx.updateWarnings ?? []).toEqual([]);
        expect(ctx.cfg.agents?.defaults).not.toHaveProperty("heartbeat");
        const { jobs } = await loadCronJobsStore(resolveCronJobsStorePathFromConfig(ctx.cfg));
        expect(jobs.filter((job) => job.agentId === "main")).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({ kind: "agentTurn", model: "openai/gpt-4o-mini" }),
          }),
        ]);
        const saved: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(saved).toMatchObject({
          agents: { defaults: { subagents: { model: "openai/gpt-4o-mini" } } },
        });
      }
      await using repeated = await prepareDoctorContext(configPath);
      await runWriteConfigHealth(repeated, { runPostWriteRepairs: false });
      expect(repeated.updateWarnings ?? []).toEqual([]);
    });
  },
);
async function fixture(home: string) {
  const { configPath, agentDir } = await writeBillingFixture(home, "gpt-5.4-mini", {
    defaults: billingDefaults("gpt-5.4", "gpt-5.4-mini"),
    entries: { main: {} },
  });
  const { runId } = createUpdateRun({ trigger: "cli" });
  const receipt = () => getUpdateRun(runId)?.steps.find((step) => step.step === retirementStep);
  const defer = () =>
    recordUpdateRunStep(runId, {
      step: retirementStep,
      status: "skipped",
      detail: "Model retirement deferred until configured plugins converge.",
    });
  return { configPath, agentDir, runId, receipt, defer };
}

function withRetirement(
  mode: "run-id" | "result-channel" | "uncorrelated" | "refused",
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  return withDoctorConfigPreflightHome(async (home) => {
    const f = await fixture(home);
    return withEnvAsync(
      {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_UPDATE_RUN_ID: mode === "run-id" || mode === "refused" ? f.runId : undefined,
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH:
          mode === "result-channel"
            ? createUpdatePostInstallDoctorResultPath()
            : mode === "refused"
              ? process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH
              : undefined,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: mode === "refused" ? "1" : undefined,
      },
      () => run(f),
    );
  });
}

it.each(["run-id", "result-channel"] as const)(
  "records package-swap deferral through %s and completes it only after the repaired config is durable",
  (correlation) =>
    withRetirement(correlation, async (f) => {
      {
        await using swap = await prepareDoctorContext(f.configPath);
        await runInitialConfigWriteHealth(swap);
        expect(resolveAgentEffectiveModelPrimary(swap.cfg, "main")).toBe("openai/gpt-5.4");
        await expectInheritedHeartbeatAutomation(swap.cfg);
        expect(f.receipt()).toMatchObject({ status: "skipped" });
      }
      await withEnvAsync({ OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" }, async () => {
        {
          await using converged = await prepareDoctorContext(f.configPath);
          expect(resolveAgentEffectiveModelPrimary(converged.cfg, "main")).toBe(
            "openai/gpt-5.6-terra",
          );
          await expectInheritedHeartbeatAutomation(converged.cfg);
          expect(
            createModelAuthAvailabilityResolver({
              cfg: converged.cfg,
              authStore: loadAuthProfileStoreForRuntime(f.agentDir),
              env: {},
            }).evaluateModelAuth("openai", {
              modelId: "gpt-5.6-terra",
              requiredProfileId: "openai:chatgpt-default",
            }),
          ).toMatchObject({
            availability: true,
            selectedProfileId: "openai:chatgpt-default",
            selectedRoute: { authRequirement: "subscription" },
          });
          expect(f.receipt()).toMatchObject({ status: "skipped" });
          await runInitialConfigWriteHealth(converged);
          expect(f.receipt()).toMatchObject({ status: "completed" });
          expect(await fs.readFile(f.configPath, "utf8")).toContain("openai/gpt-5.6-terra");
          const completedRun = getUpdateRun(f.runId);
          if (!completedRun) {
            throw new Error("Expected the update run after Doctor committed its repair.");
          }
          expect(renderUpdateRunReport(completedRun).lines).toContain(
            "Warning: Deferred model retirement repair completed after plugin convergence.",
          );
        }

        f.defer();
        await using repeated = await prepareDoctorContext(f.configPath);
        expect(repeated.configResult.shouldWriteConfig).toBe(false);
        await runInitialConfigWriteHealth(repeated);
        expect(f.receipt()).toMatchObject({ status: "completed" });
      });
    }),
);

it("leaves the active update untouched without an update correlation channel", () =>
  withRetirement("uncorrelated", async (f) => {
    const before = getUpdateRun(f.runId);
    await using ctx = await prepareDoctorContext(f.configPath);
    await runInitialConfigWriteHealth(ctx);
    expect(resolveAgentEffectiveModelPrimary(ctx.cfg, "main")).toBe("openai/gpt-5.4");
    await expectInheritedHeartbeatAutomation(ctx.cfg);
    expect(getUpdateRun(f.runId)).toEqual(before);
  }));

it("preserves the deferred receipt when the repaired config write is refused", () =>
  withRetirement("refused", async (f) => {
    f.defer();
    await using ctx = await prepareDoctorContext(f.configPath);
    expect(resolveAgentEffectiveModelPrimary(ctx.cfg, "main")).toBe("openai/gpt-5.6-terra");
    await expectInheritedHeartbeatAutomation(ctx.cfg);
    const before = await fs.readFile(f.configPath, "utf8");
    ctx.cfg.gateway = { ...ctx.cfg.gateway, port: -1 };
    await runInitialConfigWriteHealth(ctx);
    expect(ctx.configWriteRefusal).toBe("validation");
    expect(f.receipt()).toMatchObject({ status: "skipped" });
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
  }));

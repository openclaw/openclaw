import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles.js";
import { createModelAuthAvailabilityResolver } from "../agents/model-auth-availability.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
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
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

describe("Doctor model billing route migration", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each([
    { multiagent: false, successor: "gpt-5.6-luna" },
    { multiagent: true, successor: "gpt-5.4-mini" },
  ])(
    "records inherited billing changes once (multiagent: $multiagent)",
    async ({ multiagent, successor }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          auth: {
            profiles: {
              "openai:default": { provider: "openai", mode: "api_key" },
              "openai:chatgpt-default": { provider: "openai", mode: "oauth" },
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-completions",
                models: [{ id: "gpt-4o-mini", name: "Heartbeat", input: ["text"] }],
              },
            },
          },
          agents: {
            defaults: {
              model: "openai/gpt-5.4",
              models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
              heartbeat: { model: "openai/gpt-4o-mini" },
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
          },
          gateway: {
            mode: "local",
            port: 19473,
            auth: { mode: "token", token: "synthetic-gateway-token" },
          },
        });
        const authDir = path.join(path.dirname(configPath), "agents", "main", "agent");
        await fs.mkdir(authDir, { recursive: true });
        await fs.writeFile(
          path.join(authDir, "auth-profiles.json"),
          JSON.stringify({
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key: "synthetic-api-key" },
              "openai:chatgpt-default": {
                type: "oauth",
                provider: "openai",
                access: "synthetic-oauth-access",
                refresh: "synthetic-oauth-refresh",
                expires: Date.now() + 3_600_000,
              },
            },
          }),
        );
        const ctx = await prepareDoctorContext(configPath);
        await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
        const expectedRoute = `openai/gpt-4o-mini via metered API-key profile openai:default -> openai/${successor} via subscription/OAuth profile openai:chatgpt-default.`;
        expect(ctx.updateWarnings).toEqual([
          expect.stringContaining(
            `Billing route changed for agents.defaults.heartbeat.model (agent main): ${expectedRoute}`,
          ),
          expect.stringContaining(
            `Billing route changed for agents.defaults.subagents.model (agent main): ${expectedRoute}`,
          ),
        ]);
        await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
        expect(ctx.updateWarnings).toHaveLength(2);
        const repeated = await prepareDoctorContext(configPath);
        await runWriteConfigHealth(repeated, { runPostWriteRepairs: false });
        expect(repeated.updateWarnings ?? []).toEqual([]);
      });
    },
  );
});

describe("Doctor deferred model retirement", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  async function fixture(home: string) {
    const configPath = await writeOpenClawConfig(home, {
      auth: {
        profiles: {
          "openai:default": { provider: "openai", mode: "api_key" },
          "openai:chatgpt-default": { provider: "openai", mode: "oauth" },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            models: [{ id: "gpt-5.4-mini", name: "Heartbeat", input: ["text"] }],
          },
        },
      },
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          heartbeat: { model: "openai/gpt-5.4-mini" },
        },
        entries: { main: {} },
      },
      gateway: {
        mode: "local",
        port: 19473,
        auth: { mode: "token", token: "synthetic-gateway-token" },
      },
    });
    const agentDir = path.join(path.dirname(configPath), "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "synthetic-api-key" },
          "openai:chatgpt-default": {
            type: "oauth",
            provider: "openai",
            access: "synthetic-oauth-access",
            refresh: "synthetic-oauth-refresh",
            expires: Date.now() + 3_600_000,
          },
        },
      }),
    );
    const { runId } = createUpdateRun({ trigger: "cli" });
    const receipt = () =>
      getUpdateRun(runId)?.steps.find((step) => step.step === "finalize:doctor:model-retirement");
    const defer = () =>
      recordUpdateRunStep(runId, {
        step: "finalize:doctor:model-retirement",
        status: "skipped",
        detail: "Model retirement deferred until configured plugins converge.",
      });
    return { configPath, agentDir, runId, receipt, defer };
  }

  it.each(["run-id", "result-channel"])(
    "records package-swap deferral through %s and completes it only after the repaired config is durable",
    async (correlation) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const f = await fixture(home);
        await withEnvAsync(
          {
            OPENCLAW_UPDATE_RUN_ID: correlation === "run-id" ? f.runId : undefined,
            OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH:
              correlation === "result-channel"
                ? createUpdatePostInstallDoctorResultPath()
                : undefined,
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          },
          async () => {
            const swap = await prepareDoctorContext(f.configPath);
            await runInitialConfigWriteHealth(swap);
            expect(swap.cfg.agents?.defaults?.heartbeat?.model).toBe("openai/gpt-5.4-mini");
            expect(f.receipt()).toMatchObject({ status: "skipped" });
            for (const [index, detail] of [
              "Heartbeat billing route changed.",
              "Subagent billing route changed.",
              "Gateway is bound to loopback.",
            ].entries()) {
              recordUpdateRunStep(f.runId, {
                step: `warning:openclaw doctor:${index + 1}`,
                status: "completed",
                detail,
              });
            }

            await withEnvAsync({ OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" }, async () => {
              const converged = await prepareDoctorContext(f.configPath);
              expect(converged.cfg.agents?.defaults?.heartbeat?.model).toBe("openai/gpt-5.6-luna");
              expect(
                createModelAuthAvailabilityResolver({
                  cfg: converged.cfg,
                  authStore: loadAuthProfileStoreForRuntime(f.agentDir),
                  env: {},
                }).evaluateModelAuth("openai", {
                  modelId: "gpt-5.6-luna",
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
              expect(await fs.readFile(f.configPath, "utf8")).toContain("openai/gpt-5.6-luna");
              const completedRun = getUpdateRun(f.runId);
              if (!completedRun) {
                throw new Error("Expected the update run after Doctor committed its repair.");
              }
              expect(renderUpdateRunReport(completedRun).lines).toContain(
                "Warning: Deferred model retirement repair completed after plugin convergence.",
              );

              f.defer();
              const repeated = await prepareDoctorContext(f.configPath);
              expect(repeated.configResult.shouldWriteConfig).toBe(false);
              await runInitialConfigWriteHealth(repeated);
              expect(f.receipt()).toMatchObject({ status: "completed" });
            });
          },
        );
      });
    },
  );

  it("leaves the active update untouched without an update correlation channel", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const f = await fixture(home);
      const before = getUpdateRun(f.runId);
      await withEnvAsync(
        {
          OPENCLAW_UPDATE_RUN_ID: undefined,
          OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: undefined,
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
        },
        async () => {
          const ctx = await prepareDoctorContext(f.configPath);
          await runInitialConfigWriteHealth(ctx);
          expect(ctx.cfg.agents?.defaults?.heartbeat?.model).toBe("openai/gpt-5.4-mini");
          expect(getUpdateRun(f.runId)).toEqual(before);
        },
      );
    });
  });

  it("preserves the deferred receipt when the repaired config write is refused", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const f = await fixture(home);
      f.defer();
      await withEnvAsync(
        {
          OPENCLAW_UPDATE_RUN_ID: f.runId,
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
        },
        async () => {
          const ctx = await prepareDoctorContext(f.configPath);
          expect(ctx.cfg.agents?.defaults?.heartbeat?.model).toBe("openai/gpt-5.6-luna");
          const before = await fs.readFile(f.configPath, "utf8");
          ctx.cfg.gateway = { ...ctx.cfg.gateway, port: -1 };
          await runInitialConfigWriteHealth(ctx);
          expect(ctx.configWriteRefusal).toBe("validation");
          expect(f.receipt()).toMatchObject({ status: "skipped" });
          expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
        },
      );
    });
  });
});

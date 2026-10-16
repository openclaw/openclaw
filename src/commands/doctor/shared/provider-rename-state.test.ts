import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentPatchedSessionModelRunGuard } from "../../../agents/session-model-auto-revert.js";
import { hashConfigRaw } from "../../../config/io.read-helpers.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { makeCronJob } from "../../../cron/delivery.test-helpers.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import { runInitialConfigWriteHealth } from "../../../flows/doctor-health-contribution-runners.config.js";
import { runCodexSessionRouteHealth } from "../../../flows/doctor-health-contribution-runners.state.js";
import type { DoctorHealthFlowContext } from "../../../flows/doctor-health-contribution-types.js";
import { acquireGatewayStateOwner } from "../../../infra/gateway-state-owner.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createDoctorPrompter } from "../../doctor-prompter.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";
import { maybeRepairProviderRenameCronJobs } from "./provider-rename-state.js";
import {
  applyProviderRenames,
  planProviderRenames,
  type ProviderRename,
} from "./provider-rename.js";

const renames: readonly ProviderRename[] = [
  { from: "ollama", to: "ollama-cloud", baseUrl: "https://ollama.com" },
];

function sourceConfig(): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: { entries: { main: {} } },
    models: {
      providers: {
        ollama: {
          baseUrl: "https://ollama.com",
          api: "ollama",
          apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
          models: ["previous", "override", "origin"].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 4096,
          })),
        },
      },
    },
  };
}

async function fixture(state: OpenClawTestState, cfg = sourceConfig()) {
  await state.writeConfig(cfg);
  const scope = (id: string) => ({
    storePath: path.join(state.sessionsDir(), "sessions.json"),
    sessionKey: `agent:main:${id}`,
    env: state.env,
  });
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const options = { repair: true, nonInteractive: true };
  return {
    cfg,
    scope,
    readConfig: async (file = state.configPath) => JSON.parse(await fs.readFile(file, "utf8")),
    writeSession: (id: string, fields: Partial<SessionEntry>) =>
      replaceSessionEntry(scope(id), { sessionId: id, updatedAt: 1, ...fields }),
    context: (
      configResult: Omit<DoctorHealthFlowContext["configResult"], "cfg"> = {},
      config = cfg,
    ): DoctorHealthFlowContext => ({
      cfg: config,
      cfgForPersistence: structuredClone(config),
      configResult: { cfg: config, providerRenames: renames, ...configResult },
      configPath: state.configPath,
      sourceConfigValid: true,
      env: state.env,
      runtime,
      options,
      prompter: createDoctorPrompter({ runtime, options }),
    }),
  };
}

function selection(provider: string, model: string, override = model) {
  return { modelProvider: provider, model, providerOverride: provider, modelOverride: override };
}

function repaired(before: SessionEntry | null | undefined, changes: Partial<SessionEntry>) {
  return { ...before, updatedAt: expect.any(Number), ...changes };
}

describe("persisted provider rename", () => {
  it.each([
    { name: "readonly config", env: { OPENCLAW_CONFIG_READONLY: "1" } },
    {
      name: "legacy update handoff",
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "0",
      },
    },
  ])("does not rename sessions when publication is skipped for $name", async ({ env }) => {
    await withOpenClawTestState({ label: "provider-rename-unpublished", env }, async (state) => {
      const { cfg: source, scope, writeSession, context } = await fixture(state);
      const configBefore = await fs.readFile(state.configPath);
      await writeSession("unpublished", selection("ollama", "model:cloud", "fallback:cloud"));
      const before = loadSessionEntry(scope("unpublished"));
      const ctx = context(
        { shouldWriteConfig: true, providerRenames: renames },
        applyProviderRenames(source, renames).config,
      );
      ctx.cfgForPersistence = source;
      await runInitialConfigWriteHealth(ctx);
      expect(ctx.configResultWriteCommitted).not.toBe(true);
      await runCodexSessionRouteHealth(ctx);
      expect(loadSessionEntry(scope("unpublished"))).toEqual(before);
      expect(await fs.readFile(state.configPath)).toEqual(configBefore);
    });
  });

  it("repairs all cron partitions under the state owner, retries config-last, then leaves later local selections alone", async () => {
    await withOpenClawTestState({ label: "provider-rename-resume" }, async (state) => {
      const { cfg: source, scope, writeSession, context, readConfig } = await fixture(state);
      await writeSession("resume", {
        modelProvider: "ollama",
        model: "previous",
      });
      const sessionBefore = loadSessionEntry(scope("resume"));
      for (const [partition, enabled] of [
        ["cron", true],
        ["inactive-cron", false],
      ] as const) {
        await saveCronJobsStore(state.statePath(partition, "jobs.json"), {
          version: 1,
          jobs: [
            makeCronJob({
              id: "rename",
              enabled,
              payload: {
                kind: "agentTurn",
                message: "Do not rewrite ollama/message",
                model: "ollama/model:cloud@ollama:saved-profile",
                fallbacks: ["ollama/fallback", "custom/unchanged"],
              },
              state: { lastRunAtMs: 123, lastRunStatus: "ok" },
            }),
          ],
        });
      }
      const activeRenames = planProviderRenames(source, renames);
      const args = { renames: activeRenames, env: state.env };
      const db = openOpenClawStateDatabase();
      const owner = acquireGatewayStateOwner({ databasePath: db.path });
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: owner.assertCurrent,
        assertDatabaseAccess: owner.assertDatabaseAccess,
      });
      try {
        await maintenance.run(async () => {
          const result = await maybeRepairProviderRenameCronJobs({ ...args, shouldRepair: true });
          expect(result.warnings).toEqual([]);
          expect(result.changes.join("\n")).toContain("2 persisted cron job(s)");
          for (const partition of ["cron", "inactive-cron"]) {
            const store = await loadCronJobsStore(state.statePath(partition, "jobs.json"));
            expect(store.jobs[0]).toMatchObject({
              enabled: partition === "cron",
              payload: {
                kind: "agentTurn",
                message: "Do not rewrite ollama/message",
                model: "ollama-cloud/model:cloud",
                fallbacks: ["ollama-cloud/fallback", "custom/unchanged"],
              },
              state: { lastRunAtMs: 123, lastRunStatus: "ok" },
            });
          }
          await maybeRepairCodexSessionRoutes({
            cfg: source,
            providerRenames: activeRenames,
            providerRenameOnly: true,
            env: state.env,
            shouldRepair: true,
          });
          expect(loadSessionEntry(scope("resume"))).toEqual(
            repaired(sessionBefore, { modelProvider: "ollama-cloud" }),
          );
          // The hosted source remains the retry marker until state repair is complete.
          expect(await readConfig()).toEqual(source);
          await runInitialConfigWriteHealth(
            context({
              providerRenames: activeRenames,
              confirmedConfigSource: {
                path: state.configPath,
                hash: hashConfigRaw(await fs.readFile(state.configPath, "utf8")),
              },
            }),
          );
          const published = await readConfig();
          expect(published.models.providers).toEqual({
            "ollama-cloud": source.models!.providers!.ollama,
          });
          expect(await readConfig(`${state.configPath}.bak`)).toEqual(source);
          const local = {
            ...published,
            agents: { entries: { main: {} }, defaults: { model: "ollama/local-model" } },
          };
          await state.writeConfig(local);
          await writeSession("resume", {
            sessionId: "new-local",
            modelProvider: "ollama",
            model: "local-model",
          });
          const localJob = makeCronJob({
            id: "new-local",
            payload: { kind: "agentTurn", message: "local", model: "ollama/local-model" },
          });
          await saveCronJobsStore(state.statePath("cron", "jobs.json"), {
            version: 1,
            jobs: [localJob],
          });
          const laterPlans = planProviderRenames(local, renames);
          expect(laterPlans).toEqual([]);
          await runInitialConfigWriteHealth(context({ providerRenames: laterPlans }, local));
          expect(loadSessionEntry(scope("resume"))?.modelProvider).toBe("ollama");
          expect(
            (await loadCronJobsStore(state.statePath("cron", "jobs.json"))).jobs[0]?.payload,
          ).toEqual(localJob.payload);
        });
      } finally {
        await maintenance.close();
        owner.release();
      }
    });
  });

  it("repairs session pairs and fallback snapshots through the batch owner before a failed selection rolls back", async () => {
    await withOpenClawTestState({ label: "provider-rename-sessions" }, async (state) => {
      const { cfg, scope, writeSession } = await fixture(
        state,
        applyProviderRenames(sourceConfig(), renames).config,
      );
      const marker = {
        prevProvider: "ollama",
        prevModel: "previous",
        prevProviderOverride: "ollama",
        prevModelOverride: "ollama/override",
        prevModelOverrideSource: "auto" as const,
        prevModelOverrideFallbackOriginProvider: "ollama",
        prevModelOverrideFallbackOriginModel: "origin",
        prevAuthProfileOverride: "custom:saved",
        prevAuthProfileOverrideSource: "user" as const,
        prevThinkingLevel: "high",
        prevContextWindow: "8192",
        ts: 123,
        source: "agent-patch" as const,
      };
      const entries: Record<string, Partial<SessionEntry>> = {
        paired: {
          ...selection("ollama", "model:cloud", "other:cloud@ollama:account"),
          agentRuntimeOverride: "openclaw",
          authProfileOverride: "ollama:account",
          authProfileOverrideSource: "user",
          modelOverrideSource: "user",
        },
        full: selection("ollama", "ollama/model:cloud", "ollama/other:cloud@ollama:account"),
        unscoped: { model: "ollama/model:cloud" },
        custom: selection("custom", "ollama/model:cloud", "ollama/other:cloud"),
        rollback: {
          ...selection("custom", "failed"),
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "ollama",
          modelOverrideFallbackOriginModel: "origin",
          modelFallback: marker,
          authProfileOverride: "custom:current",
          agentRuntimeOverride: "openclaw",
        },
      };
      for (const [id, entry] of Object.entries(entries)) {
        await writeSession(id, entry);
      }
      const readEntries = () =>
        Object.fromEntries(Object.keys(entries).map((id) => [id, loadSessionEntry(scope(id))]));
      const before = readEntries();
      const args = { cfg, env: state.env, providerRenames: renames, providerRenameOnly: true };
      expect(
        (await maybeRepairCodexSessionRoutes({ ...args, shouldRepair: true })).repairedSessions,
      ).toBe(4);
      const after = readEntries();
      for (const id of ["paired", "full"]) {
        expect(after[id]).toEqual(
          repaired(
            before[id],
            selection(
              "ollama-cloud",
              id === "paired" ? "model:cloud" : "ollama-cloud/model:cloud",
              id === "paired" ? "other:cloud" : "ollama-cloud/other:cloud",
            ),
          ),
        );
      }
      expect(after.unscoped).toEqual(
        repaired(before.unscoped, { model: "ollama-cloud/model:cloud" }),
      );
      expect(after.custom).toEqual(before.custom);
      expect(after.rollback).toEqual(
        repaired(before.rollback, {
          modelOverrideFallbackOriginProvider: "ollama-cloud",
          modelFallback: {
            ...marker,
            prevProvider: "ollama-cloud",
            prevProviderOverride: "ollama-cloud",
            prevModelOverride: "ollama-cloud/override",
            prevModelOverrideFallbackOriginProvider: "ollama-cloud",
          },
        }),
      );
      const guard = await createAgentPatchedSessionModelRunGuard({
        cfg,
        ...scope("rollback"),
        agentId: "main",
        onError: (error) => {
          throw error;
        },
      });
      await guard.fail(new Error("selected model does not exist"), "model_not_found");
      expect(loadSessionEntry(scope("rollback"))).toMatchObject({
        ...selection("ollama-cloud", "previous", "ollama-cloud/override"),
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "ollama-cloud",
        modelOverrideFallbackOriginModel: "origin",
        authProfileOverride: "custom:saved",
        authProfileOverrideSource: "user",
        thinkingLevel: "high",
        contextWindow: "8192",
        agentRuntimeOverride: "openclaw",
      });
      expect(loadSessionEntry(scope("rollback"))?.modelFallback).toBeUndefined();
    });
  });
});

import { describe, expect, it } from "vitest";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { loadCronStore, resolveCronStorePathAsync } from "../cron/store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applyMigrationCronJob,
  createMigrationAgent,
  type MigrationCronJob,
} from "./migration-runtime.js";
import type { MigrationProviderContext } from "./plugin-entry.js";

const job: MigrationCronJob = {
  id: "migration-source-reminder",
  agentId: "main",
  name: "Morning summary",
  message: "Summarize today's tasks.",
  enabled: true,
  schedule: { kind: "cron", expr: "15 9 * * 1-5", tz: "America/Los_Angeles" },
};

describe("native migration scheduler owner", () => {
  it("persists source timing and activation once, refuses edited retries, and never runs jobs during import", async () => {
    await withOpenClawTestState({ prefix: "migration-cron-" }, async (state) => {
      const config = { agents: { entries: { main: {} } } };
      await state.writeConfig(config);
      const ctx: MigrationProviderContext = {
        config,
        stateDir: state.stateDir,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        configRuntime: {
          current: () => config,
          async mutateConfigFile() {
            throw new Error(
              "Native agent and scheduler owners must use their own canonical config writer.",
            );
          },
        },
      };
      await expect(applyMigrationCronJob(ctx, job)).rejects.toThrow("offline migration owner");
      await runWithLocalStateOwner({
        method: "migrate.apply",
        params: {},
        target: "migration scheduler fixture",
        onForeignOwner: "refuse",
        runLocal: async () => {
          expect(await applyMigrationCronJob(ctx, job)).toBe("created");
          expect(await applyMigrationCronJob(ctx, job)).toBe("existing");
          expect(await applyMigrationCronJob(ctx, { ...job, message: "A changed prompt." })).toBe(
            "conflict",
          );
          expect(
            await applyMigrationCronJob(ctx, { ...job, id: "disabled-job", enabled: false }),
          ).toBe("created");
          await expect(
            applyMigrationCronJob(ctx, { ...job, id: "unknown-agent-job", agentId: "absent" }),
          ).rejects.toThrow("configured agent");
          expect(
            await createMigrationAgent(ctx, {
              id: "imported",
              name: "Imported",
              workspace: state.path("workspace-imported"),
              agentDir: state.agentDir("imported"),
            }),
          ).toMatchObject({ status: "created" });
          expect(
            await applyMigrationCronJob(ctx, { ...job, id: "imported-job", agentId: "imported" }),
          ).toBe("created");
          const stored = await loadCronStore(await resolveCronStorePathAsync());
          expect(stored.jobs).toHaveLength(3);
          expect(stored.jobs.find((entry) => entry.id === job.id)).toMatchObject({
            agentId: "main",
            enabled: true,
            schedule: {
              kind: "cron",
              expr: "15 9 * * 1-5",
              tz: "America/Los_Angeles",
              staggerMs: 0,
            },
            payload: { kind: "agentTurn", message: "Summarize today's tasks." },
            delivery: { mode: "none" },
          });
          expect(stored.jobs.find((entry) => entry.id === "disabled-job")?.enabled).toBe(false);
          expect(stored.jobs.every((entry) => entry.state.lastRunAtMs === undefined)).toBe(true);
          await expect(
            applyMigrationCronJob({ ...ctx, stateDir: state.path("staging") }, job),
          ).rejects.toThrow("after onboarding promotion");
        },
      });
    });
  });
});

import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { captureAuthProfileAuthorization } from "../../../agents/auth-profiles/authorization.js";
import { persistAuthProfileBatch } from "../../../agents/auth-profiles/upsert-with-lock.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import { getCronStoreKysely } from "../../../cron/store/schema.js";
import type { CronStoredJob } from "../../../cron/types.js";
import { executeSqliteQuerySync } from "../../../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { withDoctorConfigMaintenance } from "../../doctor-config-flow.test-support.js";
import { maybeRepairCronInferenceBindings } from "./inference-binding-migration.js";
import { inspectCronJobsForDoctor } from "./store-repair.js";

it("backs up captured accounts, converts exact routes, and pauses mismatches without deleting rows", async () => {
  await withOpenClawTestState({ label: "cron-pin-migration" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
        defaults: { model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] } },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await persistAuthProfileBatch({
      profiles: [
        {
          profileId: "openai:reports",
          credential: { type: "api_key", provider: "openai", key: "synthetic-reports-key" },
        },
      ],
    });
    const authorization = await captureAuthProfileAuthorization({
      profileId: "openai:reports",
      cfg,
      agentDir: state.agentDir(),
      assertCurrent() {},
    });
    const binding = {
      version: 1,
      provider: "openai",
      profileId: "openai:reports",
      authorizationId: authorization.authorizationId,
      authRequirement: "api-key",
      runtime: "openclaw",
      source: "auto",
    };
    authorization.dispose();
    const storePath = state.statePath("cron", "jobs.json");
    const job = (id: string, model?: string): CronStoredJob => ({
      id,
      name: id,
      agentId: "main",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
      wakeMode: "now",
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      payload: {
        kind: "agentTurn",
        message: "Prepare the weekly report",
        ...(model ? { model } : {}),
      },
      state: { lastRunAtMs: 123, lastRunStatus: "ok" },
    });
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [
        job("inherit"),
        job("revoked"),
        job("unbound"),
        job("explicit", "openai/gpt-4.1-mini@openai:reports"),
      ],
    });
    const original = await inspectCronJobsForDoctor({ env: process.env });
    runOpenClawStateWriteTransaction(({ db }) => {
      for (const row of original.jobs.filter(({ id }) => id !== "unbound")) {
        executeSqliteQuerySync(
          db,
          getCronStoreKysely(db)
            .updateTable("cron_jobs")
            .set({
              job_json: JSON.stringify({
                ...row.definition,
                inferenceBinding:
                  row.id === "revoked" ? { ...binding, authorizationId: "a".repeat(64) } : binding,
              }),
            })
            .where("store_key", "=", row.storeKey)
            .where("job_id", "=", row.id),
        );
      }
    });
    expect((await loadCronJobsStore(storePath)).jobs.map(({ id }) => id)).toEqual(["unbound"]);
    const pending = await inspectCronJobsForDoctor({ env: process.env });
    expect(
      (await maybeRepairCronInferenceBindings({ cfg, shouldRepair: false })).warnings,
    ).toHaveLength(3);
    expect(await inspectCronJobsForDoctor({ env: process.env })).toEqual(pending);
    const result = await withDoctorConfigMaintenance(() =>
      maybeRepairCronInferenceBindings({ cfg, shouldRepair: true }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "inherit (inherit): pinned openai/gpt-4.1@openai:reports on openclaw",
        ),
        expect.stringContaining(
          "explicit (explicit): pinned openai/gpt-4.1-mini@openai:reports on openclaw",
        ),
        expect.stringContaining("revoked (revoked): paused because"),
      ]),
    );
    const backup = result.changes.find((line) => line.startsWith("Saved pre-repair cron backup: "));
    expect(backup).toBeDefined();
    expect(
      (await fs.stat(backup!.replace("Saved pre-repair cron backup: ", ""))).size,
    ).toBeGreaterThan(0);
    const saved = (await loadCronJobsStore(storePath)).jobs;
    expect(saved).toHaveLength(4);
    for (const migrated of saved) {
      expect(migrated).not.toHaveProperty("inferenceBinding");
      expect(migrated.state.lastRunAtMs).toBe(123);
    }
    expect(saved.find(({ id }) => id === "inherit")).toMatchObject({
      enabled: true,
      payload: { model: "openai/gpt-4.1@openai:reports", modelRuntime: "openclaw" },
    });
    expect(saved.find(({ id }) => id === "revoked")).toMatchObject({ enabled: false });
    const repaired = await inspectCronJobsForDoctor({ env: process.env });
    expect(repaired.jobs.find(({ id }) => id === "unbound")).toEqual(
      original.jobs.find(({ id }) => id === "unbound"),
    );
    expect(
      await withDoctorConfigMaintenance(() =>
        maybeRepairCronInferenceBindings({ cfg, shouldRepair: true }),
      ),
    ).toEqual({ changes: [], warnings: [] });
  });
});

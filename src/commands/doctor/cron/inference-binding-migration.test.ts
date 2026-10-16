import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../../../agents/auth-profiles/upsert-with-lock.js";
import { resolveCronJobConfigRevision } from "../../../cron/config-revision.js";
import { captureCronInferenceBinding } from "../../../cron/inference-binding.runtime.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  prepareCronRunReceiptClaim,
} from "../../../cron/store/run-receipt-store.test-support.js";
import type { CronStoredJob } from "../../../cron/types.js";
import { runLegacyCronHealth } from "../../../flows/doctor-health-contribution-runners.state.js";
import { mintCronStandingGrantLocked } from "../../../gateway/operator-approval-standing-grants.worker.js";
import {
  validateCronStandingGrant,
  revokeCronStandingGrant,
} from "../../../gateway/operator-approval-store.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  prepareDoctorContext,
  withDoctorConfigMaintenance,
} from "../../doctor-config-flow.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function repair(configPath: string) {
  await withDoctorConfigMaintenance(async () => {
    await using ctx = await prepareDoctorContext(configPath);
    await runLegacyCronHealth(ctx);
  });
}

function legacyJob(id: string, model?: string): CronStoredJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 2,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
    sessionTarget: "isolated",
    wakeMode: "now",
    delivery: { mode: "none" },
    payload: {
      kind: "agentTurn",
      message: "Synthetic scheduled work",
      ...(model ? { model } : {}),
      fallbacks: ["openai/gpt-5.4"],
    },
    state: { lastRunAtMs: 123, lastRunStatus: "ok", consecutiveErrors: 2 },
  };
}

it("adopts canonical SQLite jobs during update Doctor without pinning inherited models or rewriting existing bindings", async () => {
  await withOpenClawTestState(
    {
      label: "cron-inference-upgrade",
      env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined },
    },
    async (state) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: { systemAgent: { agentId: "main" }, model: "openai/gpt-5.5" },
        },
        auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" as const } } },
        plugins: { allow: ["openai"], slots: { memory: "none" } },
      };
      await state.writeConfig(cfg);
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Unexpected network request in offline migration"),
      );
      await persistAuthProfileBatch({
        profiles: [
          {
            profileId: "openai:default",
            credential: {
              type: "oauth",
              provider: "openai",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: Date.now() + 3_600_000,
              accountId: "synthetic-account",
            },
          },
        ],
      });
      const binding = await captureCronInferenceBinding({
        cfg,
        agentId: "main",
        model: "openai/gpt-5.5@openai:default",
      });
      expect(binding).toBeDefined();
      const jobs = [
        legacyJob("pinned", "openai/gpt-5.5"),
        legacyJob("inherited"),
        { ...legacyJob("bound"), inferenceBinding: binding },
      ];
      const storePath = state.statePath("cron", "jobs.json");
      const inactivePath = state.statePath("inactive-cron", "jobs.json");
      const inactive = { ...legacyJob("disabled", "openai/gpt-5.5"), enabled: false };
      await saveCronJobsStore(storePath, { version: 1, jobs });
      await saveCronJobsStore(inactivePath, { version: 1, jobs: [inactive] });
      await expect(fs.stat(state.statePath("cron", "jobs-quarantine.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const database = () => openOpenClawStateDatabase();
      database()
        .db.prepare(
          `INSERT INTO operator_approvals (cursor_id, approval_id, resolution_ref, kind, status, presentation_json, reviewer_device_ids_json, audience_session_keys_json, runtime_epoch, created_at_ms, expires_at_ms, updated_at_ms, decision, terminal_reason, resolved_at_ms, resolver_kind) VALUES (1, 'legacy-approval', ?, 'exec', 'allowed', '{}', '[]', '[]', 'synthetic-epoch', 1, 3, 2, 'allow-always', 'user', 2, 'device')`,
        )
        .run("a".repeat(43));
      runOpenClawStateWriteTransaction((db) =>
        mintCronStandingGrantLocked(db, {
          approvalId: "legacy-approval",
          agentId: "main",
          cronJobId: "pinned",
          jobConfigRevision: resolveCronJobConfigRevision(jobs[0]!),
          operationBinding: "synthetic-approved-operation",
          nowMs: 2,
          expiresAtMs: null,
        }),
      );
      const grantBefore = database()
        .db.prepare("SELECT * FROM operator_approval_standing_grants WHERE cron_job_id = 'pinned'")
        .get()!;
      const generationBefore = database()
        .db.prepare("SELECT grant_definition_generation FROM cron_jobs WHERE job_id = 'pinned'")
        .get();

      // The ordinary cron contribution also runs in repairing update Doctor.
      await repair(state.configPath);
      const repaired = (await loadCronJobsStore(storePath)).jobs;
      for (const [index, job] of repaired.entries()) {
        expect(job.inferenceBinding).toMatchObject({
          provider: "openai",
          profileId: "openai:default",
          authRequirement: "subscription",
        });
        const { inferenceBinding: _binding, ...definition } = job;
        const { inferenceBinding: _previous, ...before } = jobs[index]!;
        expect(definition).toEqual(before);
      }
      expect(repaired[1]!.payload).not.toHaveProperty("model");
      expect(repaired[2]!.inferenceBinding).toEqual(binding);
      expect((await loadCronJobsStore(inactivePath)).jobs[0]).toMatchObject({
        ...inactive,
        inferenceBinding: { profileId: "openai:default" },
      });
      const backups = (await fs.readdir(state.statePath("state"))).filter(
        (name) => name.includes(".doctor-cron-") && name.endsWith(".bak"),
      );
      expect(backups).toHaveLength(1);
      await repair(state.configPath);
      expect((await loadCronJobsStore(storePath)).jobs).toEqual(repaired);
      expect(
        (await fs.readdir(state.statePath("state"))).filter(
          (name) => name.includes(".doctor-cron-") && name.endsWith(".bak"),
        ),
      ).toEqual(backups);
      const migratedJob = repaired[0]!;
      const revision = resolveCronJobConfigRevision(migratedJob);
      const grantAfter = database()
        .db.prepare("SELECT * FROM operator_approval_standing_grants WHERE cron_job_id = 'pinned'")
        .get()!;
      expect(grantAfter).toEqual({ ...grantBefore, job_config_revision: revision });
      expect(
        database()
          .db.prepare("SELECT grant_definition_generation FROM cron_jobs WHERE job_id = 'pinned'")
          .get(),
      ).toEqual(generationBefore);
      const prepared = prepareCronRunReceiptClaim({
        storePath,
        job: migratedJob,
        agentId: "main",
        startedAtMs: Date.now(),
        observed: undefined,
      });
      const handle = runOpenClawStateWriteTransaction(({ db }) =>
        claimCronRunReceiptInDatabaseForTest({ database: db, prepared }),
      );
      const lookup = {
        agentId: "main",
        cronJobId: "pinned",
        jobConfigRevision: revision,
        operationBinding: "synthetic-approved-operation",
        handle,
      };
      expect(await validateCronStandingGrant(lookup)).toMatchObject({ outcome: "consumed" });
      const grantId = String(grantAfter.grant_id);
      await revokeCronStandingGrant({ grantId, revokedBy: "synthetic-operator" });
      expect(await validateCronStandingGrant(lookup)).toMatchObject({ outcome: "revoked" });
    },
  );
});

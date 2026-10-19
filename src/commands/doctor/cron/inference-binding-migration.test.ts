import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { upsertAuthProfileWithLockOrThrow } from "../../../agents/auth-profiles/upsert-with-lock.js";
import { resolveCronJobConfigRevision } from "../../../cron/config-revision.js";
import { captureCronInferenceBinding } from "../../../cron/inference-binding.runtime.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import * as receipts from "../../../cron/store/run-receipt-store.test-support.js";
import type { CronStoredJob } from "../../../cron/types.js";
import { runLegacyCronHealth } from "../../../flows/doctor-health-contribution-runners.state.js";
import { mintCronStandingGrantLocked } from "../../../gateway/operator-approval-standing-grants.worker.js";
import * as grants from "../../../gateway/operator-approval-store.js";
import * as stateDb from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import * as doctor from "../../doctor-config-flow.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function repair(configPath: string) {
  await doctor.withDoctorConfigMaintenance(async () => {
    await using ctx = await doctor.prepareDoctorContext(configPath);
    await runLegacyCronHealth(ctx);
  });
}

function legacyJob(id: string, model?: string): CronStoredJob {
  return {
    ...receipts.makeCronReceiptJob(id, "main"),
    updatedAtMs: 2,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
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
      await upsertAuthProfileWithLockOrThrow({
        profileId: "openai:default",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 3_600_000,
          accountId: "synthetic-account",
        },
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
      const query = (sql: string) => stateDb.openOpenClawStateDatabase().db.prepare(sql).get();
      const backupsOnDisk = async () =>
        (await fs.readdir(state.statePath("state"))).filter(
          (name) => name.includes(".doctor-cron-") && name.endsWith(".bak"),
        );
      stateDb
        .openOpenClawStateDatabase()
        .db.exec(
          `INSERT INTO operator_approvals (cursor_id, approval_id, resolution_ref, kind, status, presentation_json, reviewer_device_ids_json, audience_session_keys_json, runtime_epoch, created_at_ms, expires_at_ms, updated_at_ms, decision, terminal_reason, resolved_at_ms, resolver_kind) VALUES (1, 'legacy-approval', '${"a".repeat(43)}', 'exec', 'allowed', '{}', '[]', '[]', 'synthetic-epoch', 1, 3, 2, 'allow-always', 'user', 2, 'device')`,
        );
      const approvedOperation = {
        agentId: "main",
        cronJobId: "pinned",
        operationBinding: "synthetic-approved-operation",
      };
      stateDb.runOpenClawStateWriteTransaction((db) =>
        mintCronStandingGrantLocked(db, {
          ...approvedOperation,
          approvalId: "legacy-approval",
          jobConfigRevision: resolveCronJobConfigRevision(jobs[0]!),
          nowMs: 2,
          expiresAtMs: null,
        }),
      );
      const grantSql =
        "SELECT g.*, j.grant_definition_generation FROM operator_approval_standing_grants g JOIN cron_jobs j ON j.job_id = g.cron_job_id WHERE g.cron_job_id = 'pinned'";
      const grantBefore = query(grantSql)!;

      await repair(state.configPath);
      const repaired = (await loadCronJobsStore(storePath)).jobs;
      const adopted = expect.objectContaining({
        provider: "openai",
        profileId: "openai:default",
        authRequirement: "subscription",
      });
      expect(repaired).toEqual(
        jobs.map((job) =>
          Object.assign({}, job, { inferenceBinding: job.inferenceBinding ?? adopted }),
        ),
      );
      expect((await loadCronJobsStore(inactivePath)).jobs[0]).toMatchObject({
        ...inactive,
        inferenceBinding: { profileId: "openai:default" },
      });
      const backups = await backupsOnDisk();
      expect(backups).toHaveLength(1);
      await repair(state.configPath);
      expect((await loadCronJobsStore(storePath)).jobs).toEqual(repaired);
      expect(await backupsOnDisk()).toEqual(backups);
      const revision = resolveCronJobConfigRevision(repaired[0]!);
      const grantAfter = query(grantSql)!;
      expect(grantAfter).toEqual({ ...grantBefore, job_config_revision: revision });
      const handle = receipts.claimCronRunReceiptForTest(storePath, repaired[0]!, Date.now());
      const lookup = { ...approvedOperation, jobConfigRevision: revision, handle };
      expect(await grants.validateCronStandingGrant(lookup)).toMatchObject({ outcome: "consumed" });
      const grantId = String(grantAfter.grant_id);
      await grants.revokeCronStandingGrant({ grantId, revokedBy: "synthetic-operator" });
      expect(await grants.validateCronStandingGrant(lookup)).toMatchObject({ outcome: "revoked" });
    },
  );
});

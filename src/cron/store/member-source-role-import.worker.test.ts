import { expect, it, vi } from "vitest";
import { migrateSharedOpenClawIdMemberSources } from "../../gateway/openclaw-id/member-source-role-import-shared.js";
import {
  legacyMemberSnapshot,
  memberRoleImport,
} from "../../gateway/openclaw-id/member-source-role-import.test-support.js";
import { mintCronStandingGrantLocked } from "../../gateway/operator-approval-standing-grants.worker.js";
import { validateCronStandingGrant } from "../../gateway/operator-approval-store.js";
import { operatorStandingGrantPublication } from "../../gateway/operator-approval-store.publication.js";
import { createWorkerEnvironmentStore } from "../../gateway/worker-environments/store.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withoutMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { resolveCronOperatorExecutionRevision } from "../service/jobs-tool-policy.js";
import { getCronJobsStoreRevision, loadCronJobsStore, saveCronJobsStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { claimCronRunReceiptForTest } from "../store/run-receipt-store.test-support.js";
import { makeCronStreamSandboxTarget } from "../stream-sandbox.test-support.js";
import type { CronStoredJob } from "../types.js";

function legacyJob(id: string): CronStoredJob {
  const job = makeCronJob({ id, agentId: "main", createdAtMs: 1, updatedAtMs: 2 });
  return {
    ...job,
    operatorSource: {
      executionRevision: resolveCronOperatorExecutionRevision(job),
      source: {
        version: 1,
        kind: "gateway",
        agentId: "main",
        sourceRunId: "retained-run",
        snapshot: legacyMemberSnapshot(),
      },
    },
  };
}

it("migrates shared source owners without SQL on the host, stale inventories, or widened grants", async () => {
  await withOpenClawTestState({ label: "member-source-shared" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const statuses = ["valid", "revoked", "stale-revision", "stale-generation", "reversed"];
    const jobs = statuses.map(legacyJob);
    jobs.find((job) => job.id === "stale-revision")!.operatorSource!.executionRevision =
      "retained-stale-execution";
    const stream: CronStoredJob = {
      ...makeCronJob({ id: "stream-only", agentId: "main", createdAtMs: 1, updatedAtMs: 2 }),
      schedule: { kind: "stream", command: ["synthetic-stream-source"] },
      streamOperatorSource: legacyMemberSnapshot(),
    };
    const sandbox: CronStoredJob = {
      ...stream,
      id: "sandbox",
      operatorSource: legacyJob("sandbox").operatorSource,
      streamOperatorSource: undefined,
      streamSandbox: makeCronStreamSandboxTarget({
        operator: {
          profileId: memberRoleImport.profileId,
          openclawIdPrincipal: legacyMemberSnapshot().openclawIdPrincipal,
          assignedRole: null,
          githubLogin: null,
          scopes: ["operator.write"],
          gatewayAccessGrant: { pluginId: "stream-access", grantId: "original-grant" },
        },
      }),
    };
    sandbox.operatorSource!.executionRevision = resolveCronOperatorExecutionRevision(sandbox);
    const staleSandbox = structuredClone(sandbox);
    staleSandbox.id = "sandbox-stale";
    staleSandbox.operatorSource!.executionRevision = "retained-stale-execution";
    const restricted = legacyJob("restricted");
    restricted.operatorSource!.source.snapshot.rolePolicy = {
      ...memberRoleImport.policy,
      scopes: ["operator.read"],
    };
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [...jobs, stream, sandbox, staleSandbox, restricted],
    });
    const database = openOpenClawStateDatabase();
    const handles = jobs.map((job) => claimCronRunReceiptForTest(storePath, job, 10));
    for (const job of jobs) {
      database.db
        .prepare(
          `INSERT INTO operator_approvals (cursor_id, approval_id, resolution_ref, kind, status,
         presentation_json, reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
         created_at_ms, expires_at_ms, updated_at_ms, decision, terminal_reason, resolved_at_ms,
         resolver_kind) VALUES (?, ?, ?, 'exec', 'allowed', '{}', '[]', '[]', 'epoch',
         1, 3, 2, 'allow-always', 'user', 2, 'device')`,
        )
        .run(statuses.indexOf(job.id) + 1, job.id, job.id.padEnd(43, "a"));
      runOpenClawStateWriteTransaction((writer) =>
        mintCronStandingGrantLocked(writer, {
          approvalId: job.id,
          agentId: "main",
          cronJobId: job.id,
          operationBinding: "retained-operation",
          jobConfigRevision: resolveCronJobConfigRevision(job),
          nowMs: 2,
          expiresAtMs: null,
        }),
      );
    }
    database.db.exec(`
      UPDATE operator_approval_standing_grants SET revoked_at_ms = 3 WHERE cron_job_id = 'revoked';
      UPDATE operator_approval_standing_grants SET job_config_revision = 'stale' WHERE cron_job_id = 'stale-revision';
      UPDATE operator_approval_standing_grant_generations SET job_definition_generation = 99
        WHERE grant_id IN (SELECT grant_id FROM operator_approval_standing_grants WHERE cron_job_id = 'stale-generation');
      UPDATE operator_approvals SET status = 'denied', decision = 'deny' WHERE approval_id = 'reversed';
    `);
    const grantRows = () =>
      database.db
        .prepare("SELECT * FROM operator_approval_standing_grants ORDER BY cron_job_id")
        .all();
    const jobRows = () => database.db.prepare("SELECT * FROM cron_jobs ORDER BY job_id").all();
    const beforeGrants = grantRows();
    const beforeJobs = jobRows();
    const environments = await createWorkerEnvironmentStore({ database, now: () => 12 });
    let publishedRevision: string | undefined;
    const unsubscribe = operatorStandingGrantPublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        for (const fact of change.receipt.facts.values()) {
          if (fact.kind === "postimage" && fact.value.cron_job_id === "valid") {
            publishedRevision = fact.value.job_config_revision;
          }
        }
      }
    });
    try {
      const intent = {
        environmentId: "environment",
        providerId: "provider",
        profileId: "worker-profile",
        profileSnapshot: { settings: {} },
        provisionOperationId: "retained-provision",
        provisionSource: { kind: "gateway" as const, snapshot: legacyMemberSnapshot() },
      };
      const beforeEnvironment = await environments.createIntent(intent);
      const revision = getCronJobsStoreRevision(cronStoreKey(storePath));
      const check = vi.fn();
      await withoutMainThreadSql(() =>
        migrateSharedOpenClawIdMemberSources(memberRoleImport, check),
      );
      expect(check).toHaveBeenCalled();
      expect(getCronJobsStoreRevision(cronStoreKey(storePath))).toBeGreaterThan(revision);
      expect(environments.get(intent.environmentId)).toEqual({
        ...beforeEnvironment,
        provisionSource: {
          ...intent.provisionSource,
          snapshot: { ...intent.provisionSource.snapshot, assignedRole: "operator" },
        },
      });
      const after = await loadCronJobsStore(storePath);
      for (const job of after.jobs) {
        if (job.id === "restricted") {
          expect(job.operatorSource).toEqual(restricted.operatorSource);
        } else if (job.id === "sandbox" || job.id === "sandbox-stale") {
          expect(job.streamSandbox).toEqual({
            ...sandbox.streamSandbox,
            operator: { ...sandbox.streamSandbox!.operator, assignedRole: "operator" },
          });
          expect(job.streamOperatorSource).toBeUndefined();
          expect(job.operatorSource).toEqual({
            ...sandbox.operatorSource,
            executionRevision:
              job.id === "sandbox"
                ? resolveCronOperatorExecutionRevision(job)
                : "retained-stale-execution",
            source: {
              ...sandbox.operatorSource!.source,
              snapshot: { ...legacyMemberSnapshot(), assignedRole: "operator" },
            },
          });
        } else if (job.id === "stream-only") {
          expect(job.streamOperatorSource).toEqual({
            ...stream.streamOperatorSource,
            assignedRole: "operator",
          });
        } else {
          const previous = jobs.find((entry) => entry.id === job.id)!;
          expect(job.operatorSource).toEqual({
            ...previous.operatorSource,
            source: {
              ...previous.operatorSource!.source,
              snapshot: { ...legacyMemberSnapshot(), assignedRole: "operator" },
            },
          });
        }
      }
      expect(publishedRevision).toBe(
        resolveCronJobConfigRevision(after.jobs.find((job) => job.id === "valid")!),
      );
      const afterJobs = jobRows();
      expect(
        afterJobs.map(({ job_json: _job, grant_definition_revision: _grant, ...row }) => row),
      ).toEqual(
        beforeJobs.map(({ job_json: _job, grant_definition_revision: _grant, ...row }) => row),
      );
      expect(grantRows()).toEqual(
        beforeGrants.map((row) =>
          row.cron_job_id === "valid"
            ? Object.assign({}, row, {
                job_config_revision: resolveCronJobConfigRevision(
                  after.jobs.find((job) => job.id === "valid")!,
                ),
              })
            : row,
        ),
      );
      for (let index = 0; index < jobs.length; index += 1) {
        const job = after.jobs.find((entry) => entry.id === jobs[index]!.id)!;
        const jobRevision = resolveCronJobConfigRevision(job);
        const result = await validateCronStandingGrant({
          agentId: "main",
          cronJobId: job.id,
          operationBinding: "retained-operation",
          jobConfigRevision: jobRevision,
          handle: { ...handles[index]!, configRevision: jobRevision },
          nowMs: 20,
        });
        expect(result.outcome).toBe(
          job.id === "valid"
            ? "consumed"
            : job.id === "revoked"
              ? "revoked"
              : "job-revision-changed",
        );
      }
      await migrateSharedOpenClawIdMemberSources(memberRoleImport, check);
      expect(jobRows()).toEqual(afterJobs);
    } finally {
      unsubscribe();
      await environments.close();
    }
  });
});

it("refuses stale preparation and leaves unsupported or malformed stored sources alone", async () => {
  await withOpenClawTestState({ label: "member-source-refusal" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const job = legacyJob("refused");
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    await expect(
      migrateSharedOpenClawIdMemberSources(memberRoleImport, () => {
        throw new Error("import preparation changed");
      }),
    ).rejects.toThrow("import preparation changed");
    expect((await loadCronJobsStore(storePath)).jobs[0]!.operatorSource).toEqual(
      job.operatorSource,
    );
    const database = openOpenClawStateDatabase();
    {
      let current = true;
      const stages: string[] = [];
      using fence = sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
        stages.push(request.stage);
        if (request.stage === "commit") {
          current = false;
        }
        admit(request, grant);
      });
      await expect(
        migrateSharedOpenClawIdMemberSources(memberRoleImport, () => {
          if (!current) {
            throw new Error("import commit changed");
          }
        }),
      ).rejects.toThrow("import commit changed");
      expect(stages).toContain("transaction");
      expect(stages).toContain("commit");
      fence.mockRestore();
    }
    expect((await loadCronJobsStore(storePath)).jobs[0]!.operatorSource).toEqual(
      job.operatorSource,
    );
    const environments = await createWorkerEnvironmentStore({ database });
    await environments.createIntent({
      environmentId: "malformed",
      providerId: "provider",
      profileId: "worker-profile",
      profileSnapshot: { settings: {} },
      provisionOperationId: "provision",
    });
    await environments.close();
    database.db
      .prepare("UPDATE worker_environments SET provision_source_json = ?")
      .run('{"kind":"invalid"}');
    await migrateSharedOpenClawIdMemberSources(memberRoleImport, () => {});
    expect(
      database.db.prepare("SELECT provision_source_json FROM worker_environments").get(),
    ).toEqual({ provision_source_json: '{"kind":"invalid"}' });
  });
});

import fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureAuthProfileAuthorization } from "../../../agents/auth-profiles/authorization.js";
import {
  persistAuthProfileBatch,
  upsertAuthProfileWithLockOrThrow,
} from "../../../agents/auth-profiles/upsert-with-lock.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  loadSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../../../cron/config-revision.js";
import { captureCronInferenceBinding } from "../../../cron/inference-binding.runtime.js";
import { prepareCronRunInference } from "../../../cron/run-inference.js";
import { resolveCronOperatorExecutionRevision } from "../../../cron/service/jobs-tool-policy.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import * as receipts from "../../../cron/store/run-receipt-store.test-support.js";
import type { CronStoredJob } from "../../../cron/types.js";
import { mintCronStandingGrantLocked } from "../../../gateway/operator-approval-standing-grants.worker.js";
import * as grants from "../../../gateway/operator-approval-store.js";
import * as snapshots from "../../../infra/sqlite-snapshot.js";
import * as stateDb from "../../../state/openclaw-state-db.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import * as doctor from "../../doctor-config-flow.test-support.js";
import { maybeRepairCronInferenceBindings } from "./inference-binding-migration.js";

const withAccounts = (run: (state: OpenClawTestState) => Promise<void>) =>
  withOpenClawTestState(
    {
      label: "cron-inference-accounts",
      env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined },
    },
    async (state) => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("No external I/O in offline migration"),
      );
      await run(state);
    },
  );

const saveProfiles = (...profiles: Parameters<typeof persistAuthProfileBatch>[0]["profiles"]) =>
  persistAuthProfileBatch({ profiles });
const saveJobs = (path: string, ...jobs: CronStoredJob[]) =>
  saveCronJobsStore(path, { version: 1, jobs });
const readJobs = async (path: string) => (await loadCronJobsStore(path)).jobs;
const apiProfile = (
  profileId: string,
  key: string,
  provider = profileId.slice(0, profileId.indexOf(":")),
) => ({
  profileId,
  credential: { type: "api_key" as const, provider, key },
});
const oauthProfile = (profileId: string, access: string) => ({
  profileId,
  credential: {
    type: "oauth" as const,
    provider: "openai",
    access,
    refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "synthetic-account",
  },
});
async function configure(state: OpenClawTestState, cfg = config(state)) {
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  return cfg;
}
const migrate = (cfg: OpenClawConfig, shouldRepair = true) =>
  maybeRepairCronInferenceBindings({ cfg, shouldRepair });

const config = (
  state: OpenClawTestState,
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"] = { model: "openai/gpt-5.5" },
): OpenClawConfig => ({
  agents: {
    entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
    defaults,
  },
  plugins: { allow: ["openai"], slots: { memory: "none" } },
});

const makeAccountJob = (id: string, model?: string) =>
  ({
    id,
    name: id,
    agentId: "main",
    enabled: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Synthetic work", ...(model ? { model } : {}) },
    delivery: { mode: "none" },
    state: {},
  }) satisfies CronStoredJob;

afterEach(() => vi.restoreAllMocks());

function legacyJob(id: string, model?: string): CronStoredJob {
  const job = makeAccountJob(id, model);
  return {
    ...job,
    enabled: true,
    updatedAtMs: 2,
    payload: {
      ...job.payload,
      message: "Synthetic scheduled work",
      fallbacks: ["openai/gpt-5.4"],
    },
    state: { lastRunAtMs: 123, lastRunStatus: "ok", consecutiveErrors: 2 },
  };
}

function legacyReminder(id: string): CronStoredJob {
  return {
    ...legacyJob(id),
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "Reminder" },
  };
}

it("adopts the main session's account for a saved system event, not the subagent model", async () => {
  await withAccounts(async (state) => {
    const cfg = await configure(
      state,
      config(state, { model: "openai/gpt-5.5", subagents: { model: "anthropic/claude-opus-4-6" } }),
    );
    await saveProfiles(apiProfile("openai:main", "fixture-main"));
    const job = legacyReminder("reminder");
    const path = state.statePath("cron", "jobs.json");
    await saveJobs(path, job);
    await doctor.withDoctorConfigMaintenance(async () => {
      await migrate(cfg);
      expect((await readJobs(path))[0]).toMatchObject({
        id: job.id,
        payload: job.payload,
        inferenceBinding: { provider: "openai", profileId: "openai:main" },
      });
    });
  });
});

it("recovers only an old upgrade's path-bound jobs, without rerunning or reenabling them", async () => {
  await withAccounts(async (state) => {
    const cfg = await configure(state);
    const profileId = "openai:default";
    await saveProfiles(apiProfile(profileId, "fixture-key"));
    const current = await captureCronInferenceBinding({
      cfg,
      agentId: "main",
      model: `openai/gpt-5.5@${profileId}`,
    });
    if (!current) {
      throw new Error("Expected a stored profile binding");
    }
    const oldRoot = state.statePath(".upgrade-example-123-456", "state");
    const old = await captureAuthProfileAuthorization({
      cfg,
      profileId,
      agentDir: state.agentDir(),
      publishedStateDir: oldRoot,
      assertCurrent() {},
    });
    const broken = { ...current, authorizationId: old.authorizationId };
    old.dispose();
    expect(broken).not.toEqual(current);
    const store = state.statePath("cron", "jobs.json");
    const job = { ...legacyJob("missed"), enabled: false, inferenceBinding: broken };
    const refused = await prepareCronRunInference({
      job,
      cfg,
      agentDir: state.agentDir(),
      binding: broken,
    });
    try {
      expect(() => refused?.assertCandidate("openai", false)).toThrow(/replaced/);
    } finally {
      refused?.dispose();
    }
    await saveJobs(
      store,
      job,
      { ...job, id: "healthy", inferenceBinding: current },
      { ...job, id: "unrelated", inferenceBinding: { ...broken, authorizationId: "f".repeat(64) } },
    );
    const before = await readJobs(store);
    await doctor.withDoctorConfigMaintenance(async () => {
      const withoutReceipt = await migrate(cfg);
      expect(withoutReceipt.changes).toEqual([]);
      expect(withoutReceipt.warnings).toEqual([
        expect.stringMatching(/\(missed\).*no usable upgrade receipt/i),
        expect.stringMatching(/\(unrelated\).*no usable upgrade receipt/i),
      ]);
      expect(withoutReceipt.warnings[0]).toContain("openclaw models auth list --agent main");
      expect(withoutReceipt.warnings[0]).toContain(
        "openclaw automations edit missed --model 'openai/gpt-5.5@<profileId>'",
      );
      expect(await readJobs(store)).toEqual(before);
      await state.writeJson(".upgraded-example.json", {
        appVersion: "example",
        ops: [
          {
            kind: "replace",
            live: state.statePath("state", "openclaw.sqlite"),
            next: join(oldRoot, "state", "openclaw.sqlite"),
          },
        ],
      });
      expect((await migrate(cfg, false)).changes).toEqual([]);
      const repaired = await migrate(cfg);
      expect(repaired.changes.join("\n")).toContain("missed");
      expect(repaired.warnings).toEqual([
        expect.stringMatching(/\(unrelated\).*no usable upgrade receipt/i),
      ]);
      expect((await migrate(cfg)).changes).toEqual([]);
    });
    const after = await readJobs(store);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    for (const [index, row] of before.entries()) {
      expect(after[index]).toEqual(row.id === job.id ? { ...row, inferenceBinding: current } : row);
    }
    const inference = await prepareCronRunInference({
      job,
      cfg,
      agentDir: state.agentDir(),
      binding: after.find((row) => row.id === job.id)?.inferenceBinding,
    });
    try {
      expect(inference).toBeDefined();
      inference?.assertCandidate("openai", false);
    } finally {
      inference?.dispose();
    }
    await upsertAuthProfileWithLockOrThrow(apiProfile(profileId, "fixture-replacement"));
    await saveJobs(store, job);
    await doctor.withDoctorConfigMaintenance(async () => {
      const replaced = await migrate(cfg);
      expect(replaced.changes).toEqual([]);
      expect(replaced.warnings).toEqual([
        expect.stringMatching(/\(missed\).*no usable upgrade receipt/i),
      ]);
    });
    expect((await readJobs(store))[0]?.inferenceBinding).toEqual(broken);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

it("adopts legacy reminders while preserving live agent turns, stored accounts and grants", async () => {
  await withAccounts(async (state) => {
    const cfg = config(state, { systemAgent: { agentId: "main" }, model: "openai/gpt-5.5" });
    Object.assign(cfg, {
      agents: { ...cfg.agents, ownership: "explicit" },
      auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" as const } } },
    });
    await configure(state, cfg);
    await upsertAuthProfileWithLockOrThrow(oauthProfile("openai:default", "synthetic-access"));
    const binding = await captureCronInferenceBinding({
      cfg,
      agentId: "main",
      model: "openai/gpt-5.5@openai:default",
    });
    expect(binding).toBeDefined();
    const pinned: CronStoredJob = {
      ...legacyReminder("pinned"),
      sessionKey: "agent:main:upgrade",
      owner: { agentId: "main", sessionKey: "agent:main:upgrade", accountId: "default" },
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:upgrade",
        ownerAccountId: "default",
      },
    };
    pinned.operatorSource = {
      executionRevision: resolveCronOperatorExecutionRevision(pinned),
      source: {
        version: 1,
        agentId: "main",
        sessionKey: "agent:main:upgrade",
        sessionId: "upgrade-session",
        lifecycleRevision: "upgrade-lifecycle",
        sourceRunId: "original-turn",
        snapshot: {
          profileId: "synthetic-owner",
          scopes: ["operator.admin"],
          assignedRole: null,
          githubLogin: null,
          grant: null,
          aliasBindingIds: [],
          authPolicy: {
            generation: "",
            grantGeneration: "synthetic-generation",
            role: "operator",
            authMethod: "token",
          },
          controlUiAdmin: true,
          localOperator: false,
          sourceIngress: "control-ui",
        },
      },
    };
    const stale: CronStoredJob = {
      ...pinned,
      id: "stale-source",
      operatorSource: { ...pinned.operatorSource, executionRevision: "stale-revision" },
    };
    const jobs = [
      pinned,
      stale,
      legacyJob("inherited"),
      { ...legacyJob("bound"), inferenceBinding: binding ?? undefined },
    ];
    const storePath = state.statePath("cron", "jobs.json");
    const inactivePath = state.statePath("inactive-cron", "jobs.json");
    const inactive = { ...legacyReminder("disabled"), enabled: false };
    await saveJobs(storePath, ...jobs);
    await saveJobs(inactivePath, inactive);
    const query = (sql: string) => stateDb.openOpenClawStateDatabase().db.prepare(sql).get();
    const backupsOnDisk = async () =>
      (await fs.readdir(state.statePath("state"))).filter(
        (name) =>
          name.startsWith("openclaw.sqlite.pre-startup-migration-") && name.endsWith(".bak"),
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

    const repair = () => doctor.withDoctorConfigMaintenance(() => migrate(cfg));
    await repair();
    const repaired = await readJobs(storePath);
    const adopted = expect.objectContaining({
      provider: "openai",
      profileId: "openai:default",
      authRequirement: "subscription",
    });
    expect(repaired).toEqual(
      jobs.map((job) =>
        Object.assign({}, job, {
          ...(job === pinned || job === stale ? { inferenceBinding: adopted } : {}),
          ...(job === pinned
            ? {
                operatorSource: {
                  source: pinned.operatorSource!.source,
                  executionRevision: resolveCronOperatorExecutionRevision(repaired[0]!),
                },
              }
            : {}),
        }),
      ),
    );
    expect(repaired[0]!.operatorSource!.executionRevision).not.toBe(
      pinned.operatorSource.executionRevision,
    );
    expect(repaired[0]!.operatorSource!.executionRevision).toBe(
      resolveCronOperatorExecutionRevision(repaired[0]!),
    );
    expect(repaired[1]!.operatorSource).toEqual(stale.operatorSource);
    expect(repaired[1]!.operatorSource!.executionRevision).not.toBe(
      resolveCronOperatorExecutionRevision(repaired[1]!),
    );
    expect((await readJobs(inactivePath))[0]).toMatchObject({
      ...inactive,
      inferenceBinding: { profileId: "openai:default" },
    });
    const backups = await backupsOnDisk();
    expect(backups).toHaveLength(1);
    await repair();
    expect(await readJobs(storePath)).toEqual(repaired);
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
  });
});

it.each([
  { name: "unbound session", linked: false, originalPresent: true },
  { name: "linked account", linked: true, originalPresent: true },
  { name: "missing linked account", linked: true, originalPresent: false },
])("respects $name when migrating personal-account jobs", async ({ linked, originalPresent }) => {
  await withAccounts(async (state) => {
    const personalId =
      "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    const cfg: OpenClawConfig = {
      ...config(state, { model: "openai/gpt-5.4" }),
      auth: { order: { openai: [personalId, "openai:shared"] } },
    };
    await configure(state, cfg);
    await saveProfiles(
      apiProfile("openai:shared", "synthetic-shared"),
      ...(originalPresent ? [apiProfile(personalId, "synthetic-personal", "openai")] : []),
    );
    const sessionScope = { agentId: "main", sessionKey: "agent:main:main" };
    if (linked) {
      await replaceSessionEntry(sessionScope, {
        sessionId: "personal-selection",
        updatedAt: 1,
        authProfileOverride: personalId,
        authProfileOverrideSource: "user-link",
      });
    }
    const originalSession = loadSessionEntry(sessionScope);
    const original = legacyReminder("personal-selection");
    const storePath = state.statePath("cron", "jobs.json");
    await saveJobs(storePath, original);
    await doctor.withDoctorConfigMaintenance(async () => {
      const result = await migrate(cfg);
      if (linked) {
        expect(result.changes).toEqual([]);
        const warnings = result.warnings.join("\n");
        expect(warnings).toContain("Selected auth profile");
        expect(warnings).toContain("is unavailable");
        expect(await readJobs(storePath)).toEqual([original]);
      } else {
        // Without a prior selection, the unattended planner skips personal accounts.
        expect(result.changes.join("\n"), result.warnings.join("\n")).toContain(
          "retain openai:shared",
        );
        expect(result.changes.join("\n")).not.toContain(personalId);
        expect((await readJobs(storePath))[0]?.inferenceBinding).toMatchObject({
          profileId: "openai:shared",
        });
      }
      expect(loadSessionEntry(sessionScope)).toEqual(originalSession);
    });
  });
});

it.each(["job edit", "account replacement", "backup failure"] as const)(
  "leaves jobs unchanged when %s prevents safe migration",
  async (change) => {
    await withAccounts(async (state) => {
      const cfg = await configure(state);
      await saveProfiles(
        change === "job edit"
          ? apiProfile("openai:a", "synthetic-original")
          : oauthProfile("openai:a", "synthetic-original-access"),
      );
      const storePath = state.statePath("cron", "jobs.json");
      const original = legacyReminder("guarded");
      await saveJobs(storePath, original);
      const snapshot = snapshots.createVerifiedSqliteSnapshot;
      vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockImplementationOnce(async (params) => {
        if (change === "backup failure") {
          throw new Error("Synthetic backup unavailable");
        }
        if (change === "job edit") {
          await saveJobs(storePath, { ...original, name: "Edited after inspection" });
        } else {
          await saveProfiles(apiProfile("openai:a", "synthetic-replacement"));
        }
        return snapshot(params);
      });
      await doctor.withDoctorConfigMaintenance(async () => {
        const result = await migrate(cfg);
        expect(result.changes).toEqual([]);
        expect(snapshots.createVerifiedSqliteSnapshot).toHaveBeenCalledOnce();
        expect(result.warnings.join("\n")).toContain("not committed");
        if (change === "backup failure") {
          expect(result.warnings.join("\n")).toContain("Synthetic backup unavailable");
        }
        expect((await readJobs(storePath))[0]).toEqual(
          change === "job edit" ? { ...original, name: "Edited after inspection" } : original,
        );
      });
    });
  },
);

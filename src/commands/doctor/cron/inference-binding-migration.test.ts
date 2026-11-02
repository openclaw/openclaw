import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { updateAuthProfileStoreWithLock } from "../../../agents/auth-profiles/store-runtime.js";
import {
  persistAuthProfileBatch,
  upsertAuthProfileWithLockOrThrow,
} from "../../../agents/auth-profiles/upsert-with-lock.js";
import * as modelRuntime from "../../../agents/embedded-agent-runner/model.js";
import { prepareEmbeddedRunAuthPlan } from "../../../agents/embedded-agent-runner/run/auth-plan.js";
import type { AgentHarness } from "../../../agents/harness/types.js";
import { makeProviderModelFixture } from "../../../agents/test-helpers/provider-model-fixture.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  loadSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { ModelProviderConfig } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../../../cron/config-revision.js";
import { captureCronInferenceBinding } from "../../../cron/inference-binding.runtime.js";
import { prepareCronRunInference } from "../../../cron/run-inference.js";
import { resolveCronOperatorExecutionRevision } from "../../../cron/service/jobs-tool-policy.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import * as receipts from "../../../cron/store/run-receipt-store.test-support.js";
import type { CronStoredJob } from "../../../cron/types.js";
import { runLegacyCronHealth } from "../../../flows/doctor-health-contribution-runners.state.js";
import { mintCronStandingGrantLocked } from "../../../gateway/operator-approval-standing-grants.worker.js";
import * as grants from "../../../gateway/operator-approval-store.js";
import * as snapshots from "../../../infra/sqlite-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import * as stateDb from "../../../state/openclaw-state-db.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import * as doctor from "../../doctor-config-flow.test-support.js";
import { createTestModelDefinition } from "../../test-runtime-config-helpers.js";
import { maybeRepairCronInferenceBindings } from "./inference-binding-migration.js";
import { inspectCronJobsForDoctor } from "./store-repair.js";

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
const contains = (text: string, ...parts: string[]) => {
  for (const part of parts) {
    expect(text).toContain(part);
  }
};
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

async function repair(configPath: string) {
  await doctor.withDoctorConfigMaintenance(async () => {
    await using ctx = await doctor.prepareDoctorContext(configPath);
    await runLegacyCronHealth(ctx);
  });
}

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

it.each(["model", "provider", "session"] as const)(
  "repairs migrated heartbeat-main on explicit Codex %s runtime twice before scheduled auth",
  async (runtimeSource) => {
    await withAccounts(async (state) => {
      const modelRef = "openai/gpt-5.5";
      const cfg = config(state, {
        systemAgent: { agentId: "main" },
        model: modelRef,
        ...(runtimeSource === "model"
          ? { models: { [modelRef]: { agentRuntime: { id: "codex" } } } }
          : {}),
      });
      if (runtimeSource === "provider") {
        cfg.models = {
          providers: {
            openai: {
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              agentRuntime: { id: "codex" },
              models: [createTestModelDefinition("gpt-5.5")],
            },
          },
        };
      }
      await configure(state, cfg);
      await saveProfiles(oauthProfile("openai:heartbeat", "synthetic-heartbeat-access"));
      const sessionKey = "agent:main:main";
      if (runtimeSource === "session") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId: "heartbeat-session",
            updatedAt: 1,
            agentRuntimeOverride: "codex",
          },
        );
      }
      // Persist the heartbeat retirement shape without inventing historical account ownership.
      const job: CronStoredJob = {
        ...legacyJob("heartbeat-main"),
        sessionTarget: `session:${sessionKey}`,
        delivery: { mode: "none", target: "owner" },
      };
      const storePath = state.statePath("cron", "jobs.json");
      await saveJobs(storePath, job);
      const model = makeProviderModelFixture<"openai-chatgpt-responses">({
        id: "gpt-5.5",
        provider: "openai",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      });
      const harness: AgentHarness = {
        id: "codex",
        label: "Codex auth boundary",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("Auth boundary must not execute inference");
        },
      };
      const stores = modelRuntime.createEmptyAgentDiscoveryStores();
      vi.spyOn(modelRuntime, "resolveModelAsync").mockResolvedValue({
        ...stores,
        model,
        logicalRef: { provider: "openai", model: "gpt-5.5" },
      });
      const run = async (stored: CronStoredJob) => {
        const inference = await prepareCronRunInference({
          cfg,
          binding: stored.inferenceBinding,
          agentDir: state.agentDir(),
        });
        try {
          inference?.assertCandidate("openai", false, "codex");
          return await withPluginRuntimeGenerationScope(
            { metadataSnapshot: createPluginMetadataSnapshotFixture() },
            () =>
              prepareEmbeddedRunAuthPlan({
                assertCurrent() {},
                runParams: {
                  sessionId: "heartbeat-session",
                  runId: "heartbeat-run",
                  agentId: "main",
                  workspaceDir: state.workspaceDir,
                  prompt: "Synthetic heartbeat",
                  timeoutMs: 1000,
                  trigger: "cron",
                  config: cfg,
                  ...inference?.runParams,
                },
                provider: "openai",
                modelId: "gpt-5.5",
                model,
                agentDir: state.agentDir(),
                workspaceDir: state.workspaceDir,
                nativeModelOwned: false,
                ...stores,
                getAgentHarness: () => harness,
                setAgentHarness() {},
                getRuntimeModel: () => model,
                getEffectiveModel: () => model,
                applyResolvedRuntimeModel() {},
                selectHarnessForPreparedAttempts: () => harness,
              }),
          );
        } finally {
          inference?.dispose();
        }
      };
      const repaired = await doctor.withDoctorConfigMaintenance(async () => {
        await migrate(cfg);
        const [first] = await readJobs(storePath);
        await migrate(cfg);
        expect(await readJobs(storePath)).toEqual([first]);
        if (!first) {
          throw new Error("Migrated heartbeat-main is missing");
        }
        return first;
      });
      const prepared = await run(repaired);
      expect(repaired).toEqual({
        ...job,
        inferenceBinding: {
          version: 1,
          provider: "openai",
          profileId: "openai:heartbeat",
          authorizationId: expect.stringMatching(/^[a-f0-9]{64}$/),
          authRequirement: "subscription",
          source: "auto",
          runtime: "codex",
        },
      });
      expect(prepared.preparedAuthAttempts).toMatchObject([
        { kind: "profile", profileId: "openai:heartbeat" },
      ]);
      expect(prepared.lockedProfileId).toBe("openai:heartbeat");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  },
);

it("adopts canonical SQLite jobs during update Doctor without pinning inherited models or rewriting existing bindings", async () => {
  await withAccounts(async (state) => {
    const cfg = config(state, { systemAgent: { agentId: "main" }, model: "openai/gpt-5.5" });
    Object.assign(cfg, {
      agents: { ...cfg.agents, ownership: "explicit" },
      auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" as const } } },
    });
    await state.writeConfig(cfg);
    await upsertAuthProfileWithLockOrThrow(oauthProfile("openai:default", "synthetic-access"));
    const binding = await captureCronInferenceBinding({
      cfg,
      agentId: "main",
      model: "openai/gpt-5.5@openai:default",
    });
    expect(binding).toBeDefined();
    const pinned: CronStoredJob = {
      ...legacyJob("pinned", "openai/gpt-5.5"),
      sessionKey: "agent:main:upgrade",
      sessionTarget: "session:agent:main:upgrade",
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
      { ...legacyJob("bound"), inferenceBinding: binding },
    ];
    const storePath = state.statePath("cron", "jobs.json");
    const inactivePath = state.statePath("inactive-cron", "jobs.json");
    const inactive = { ...legacyJob("disabled", "openai/gpt-5.5"), enabled: false };
    await saveJobs(storePath, ...jobs);
    await saveJobs(inactivePath, inactive);
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
    const repaired = await readJobs(storePath);
    const adopted = expect.objectContaining({
      provider: "openai",
      profileId: "openai:default",
      authRequirement: "subscription",
    });
    expect(repaired).toEqual(
      jobs.map((job) =>
        Object.assign({}, job, {
          inferenceBinding: job.inferenceBinding ?? adopted,
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
    await repair(state.configPath);
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

const session = (id: string, overrides: Partial<SessionEntry>) =>
  replaceSessionEntry(
    { agentId: "main", sessionKey: `agent:main:cron:${id}` },
    {
      sessionId: id,
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
      ...overrides,
    },
  );

const configuredModel = (id: string) => createTestModelDefinition(id, { maxTokens: 1024 });

const provider = (apiKey: string, baseUrl: string): ModelProviderConfig => ({
  api: "openai-completions",
  auth: "api-key",
  baseUrl,
  apiKey,
  models: [configuredModel("model")],
});

it("warns that an unbound job whose default moved to a stored account is refused until it records one", async () => {
  await withAccounts(async (state) => {
    // The job last ran on a configured key; the default now resolves to a stored account.
    const cfg = await configure(state);
    await saveProfiles(apiProfile("openai:manual", "synthetic-manual"));
    const storePath = state.statePath("cron", "jobs.json");
    await saveJobs(storePath, legacyJob("hourly"));
    await doctor.withDoctorConfigMaintenance(async () => {
      const preview = await migrate(cfg, false);
      expect(preview.changes).toEqual([]);
      contains(
        preview.warnings.join("\n"),
        "Automation hourly (hourly): retain openai:manual for openai/gpt-5.5",
        "Its runs are refused until it records this account",
        "openclaw doctor --fix",
      );
    });
  });
});

it("records the planner's first account for ambiguous jobs, keeps direct keys unbound and refuses missing accounts instead of pinning a previous fallback", async () => {
  await withAccounts(async (state) => {
    const cfg = config(state, {
      systemAgent: { agentId: "main" },
      model: "openai/gpt-5.5",
      models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
      modelPolicy: {
        allow: [
          "openai/gpt-5.5",
          "openai/gpt-5.4",
          "synthetic/model",
          "literal/model",
          "native-command/model",
          "ollama/llama3.3",
        ],
      },
    });
    cfg.models = {
      providers: {
        synthetic: provider("synthetic:stored", "https://invalid.test/v1"),
        literal: provider("synthetic-direct-key", "https://literal.invalid.test/v1"),
        "native-command": {
          api: "openai-responses",
          baseUrl: "https://native.invalid.test/v1",
          auth: "native-command",
          agentRuntime: { id: "codex" },
          models: [configuredModel("model")],
        },
        ollama: {
          api: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          models: [configuredModel("llama3.3")],
        },
      },
    };
    await configure(state, cfg);
    await saveProfiles(
      apiProfile("openai:a", "synthetic-a"),
      apiProfile("openai:b", "synthetic-b"),
      apiProfile("synthetic:stored", "synthetic-stored-key"),
      apiProfile("synthetic:other", "synthetic-other-key"),
      apiProfile("literal:stored", "synthetic-literal-stored-key"),
    );
    await updateAuthProfileStoreWithLock({
      updater(store) {
        // The usual first account is rate-limited while Doctor runs; that must not move the job.
        store.usageStats = { "openai:a": { cooldownUntil: Date.now() + 60_000 } };
        return true;
      },
    });
    const sessionScope = { agentId: "main", sessionKey: "agent:main:cron:session" };
    await session("session", {
      authProfileOverride: "openai:b",
      authProfileOverrideSource: "user",
    });
    await session("previous-fallback", {
      providerOverride: "synthetic",
      modelOverride: "model",
      modelOverrideSource: "auto",
      modelProvider: "synthetic",
      model: "model",
    });
    const selectedAccount = {
      authProfileOverride: "openai:a",
      authProfileOverrideSource: "user" as const,
    };
    await session("native-session", { ...selectedAccount, agentRuntimeOverride: "codex" });
    await session("native-locked", {
      ...selectedAccount,
      modelSelectionLocked: true,
      agentHarnessId: "codex",
    });
    const selectedSession = loadSessionEntry(sessionScope);
    const original = [
      makeAccountJob("explicit", "openai/gpt-5.5@openai:a"),
      makeAccountJob("session"),
      makeAccountJob("ambiguous"),
      makeAccountJob("missing", "openai/gpt-5.5@openai:missing"),
      makeAccountJob("previous-fallback"),
      makeAccountJob("direct", "literal/model"),
      makeAccountJob("provider-account", "synthetic/model"),
      makeAccountJob("native-config", "openai/gpt-5.4@openai:a"),
      makeAccountJob("native-session"),
      makeAccountJob("native-locked"),
      makeAccountJob("native-command", "native-command/model"),
      makeAccountJob("local", "ollama/llama3.3"),
      { ...makeAccountJob("deleted-agent"), agentId: "deleted" },
      makeAccountJob("unavailable-model", "openai/does-not-exist"),
    ];
    const storePath = state.statePath("cron", "jobs.json");
    await saveJobs(storePath, ...original);
    const malformedPath = state.statePath("inactive-cron", "jobs.json");
    const laterPath = state.statePath("z-later-cron", "jobs.json");
    await saveJobs(malformedPath, makeAccountJob("malformed", "openai/gpt-5.5@openai:a"));
    await saveJobs(laterPath, makeAccountJob("after-malformed", "openai/gpt-5.5@openai:a"));
    // Reproduce persisted legacy bytes rejected by current creation; no runtime load repairs it.
    stateDb.runOpenClawStateWriteTransaction(({ db }) => {
      db.prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.sessionTarget', 'session:') WHERE job_id = 'malformed'",
      ).run();
    });
    await doctor.withDoctorConfigMaintenance(async () => {
      const malformedBefore = (await inspectCronJobsForDoctor({ env: process.env })).jobs.find(
        (entry) => entry.id === "malformed",
      );
      expect(malformedBefore?.definition?.sessionTarget).toBe("session:");
      const preview = await migrate(cfg, false);
      expect(preview.changes).toEqual([]);
      expect(preview.warnings.join("\n")).toContain("openclaw doctor --fix");
      expect(await readJobs(storePath)).toEqual(original);
      const result = await migrate(cfg);
      const warnings = result.warnings.join("\n");
      contains(warnings, "malformed", "invalid cron sessionTarget session id");
      // Several eligible accounts: the run's first planned account is recorded, not refused.
      expect(warnings).not.toContain("More than one inference account");
      expect(result.changes.join("\n")).toContain(
        "Automation ambiguous (ambiguous): retain openai:a for openai/gpt-5.5",
      );
      expect(result.changes.join("\n")).toContain("Also eligible: openai:b");
      // A provider-config key needs no adoption: the job keeps running on it unbound.
      expect(warnings).not.toContain("Automation direct (direct)");
      contains(
        warnings,
        "openai:missing",
        "deleted-agent",
        "unavailable-model",
        "modelPolicy.allow",
        "native-locked",
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(warnings).not.toContain("synthetic-direct-key");
      const saved = await readJobs(storePath);
      // A previous auto fallback is not the job's account: it keeps the default's first account.
      const bindings = {
        explicit: { profileId: "openai:a", source: "user" },
        session: { profileId: "openai:b", source: "user" },
        ambiguous: { profileId: "openai:a", source: "auto" },
        "previous-fallback": { provider: "openai", profileId: "openai:a" },
        "provider-account": { provider: "synthetic", profileId: "synthetic:stored" },
        "native-config": { profileId: "openai:a", runtime: "codex" },
        "native-session": { profileId: "openai:a", runtime: "codex" },
      };
      expect(Object.fromEntries(saved.map((j) => [j.id, j.inferenceBinding]))).toMatchObject(
        bindings,
      );
      expect((await readJobs(laterPath))[0]?.inferenceBinding).toMatchObject({
        profileId: "openai:a",
      });
      expect(
        (await inspectCronJobsForDoctor({ env: process.env })).jobs.find(
          (entry) => entry.id === "malformed",
        ),
      ).toEqual(malformedBefore);
      for (const unchanged of original.filter((j) => !(j.id in bindings))) {
        expect(saved.find((j) => j.id === unchanged.id)).toEqual(unchanged);
      }
      expect(loadSessionEntry(sessionScope)).toEqual(selectedSession);
    });
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
    const sessionScope = { agentId: "main", sessionKey: "agent:main:cron:personal-selection" };
    if (linked) {
      await session("personal-selection", {
        authProfileOverride: personalId,
        authProfileOverrideSource: "user-link",
      });
    }
    const originalSession = loadSessionEntry(sessionScope);
    const original = makeAccountJob("personal-selection");
    const storePath = state.statePath("cron", "jobs.json");
    await saveJobs(storePath, original);
    await doctor.withDoctorConfigMaintenance(async () => {
      const result = await migrate(cfg);
      if (linked) {
        expect(result.changes).toEqual([]);
        const warnings = result.warnings.join("\n");
        contains(
          warnings,
          "inference account was not migrated",
          'Selected auth profile "personal:',
          "is unavailable",
          "openai/gpt-5.5@<profileId>",
        );
        expect(await readJobs(storePath)).toEqual([original]);
      } else {
        // Without a prior selection, the unattended planner skips personal accounts.
        expect(result.changes.join("\n")).toContain("retain openai:shared");
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
      const original = makeAccountJob("guarded");
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

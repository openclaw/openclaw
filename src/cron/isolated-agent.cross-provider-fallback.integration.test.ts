import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import {
  removeAuthProfilesAcrossOwnerStores,
  setAuthProfileOrder,
} from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store-runtime.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../agents/ai-transport-runtime-host.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  apiKeyProfile,
  completedSse,
  listenLoopbackProvider,
  loopbackModelRuntime,
  loopbackProviderConfig,
  QUOTA_EXHAUSTED_BODY,
} from "./cross-provider-fallback.test-support.js";
import {
  captureCronFallbackInferenceAccounts,
  captureCronInferenceBinding,
} from "./inference-binding.runtime.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent/run.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

// Scheduled jobs bound to one provider account (#172590) must still fail over to another
// provider's recorded account (#192009, #192463). Only provider HTTP is faked, on loopback.

type PrimaryMode = "quota" | "ok";

type Fixture = {
  state: OpenClawTestState;
  cfg: OpenClawConfig;
  hits: { primary: string[]; backup: string[] };
  setPrimary: (mode: PrimaryMode) => void;
  storePath: string;
  run: (job: CronStoredJob) => ReturnType<typeof runCronIsolatedAgentTurn>;
  reload: (job: CronStoredJob) => Promise<CronStoredJob>;
};

function withFallbackFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: { fallbacks?: string[] } = {},
) {
  return withOpenClawTestState(
    { label: "cron-cross-provider-fallback", env: { OPENAI_API_KEY: undefined } },
    async (state) => {
      installPrivateUpdateHandoffStore(state.root);
      let primaryMode: PrimaryMode = "quota";
      const hits = { primary: [] as string[], backup: [] as string[] };
      const primary = await listenLoopbackProvider((req, res) => {
        req.resume();
        hits.primary.push(String(req.headers.authorization));
        if (primaryMode === "ok") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(completedSse("gpt-4.1", "served by primary provider"));
          return;
        }
        res.writeHead(429, { "content-type": "application/json" });
        res.end(QUOTA_EXHAUSTED_BODY);
      });
      const backup = await listenLoopbackProvider((req, res) => {
        req.resume();
        hits.backup.push(String(req.headers.authorization));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(completedSse("gpt-4.1", "served by backup provider"));
      });
      const cfg: OpenClawConfig = {
        plugins: { allow: ["openai"], slots: { memory: "none" } },
        skills: { load: { watch: false } },
        tools: { deny: ["*"] },
        auth: {
          profiles: {
            "openai:primary": { provider: "openai", mode: "api_key" },
            "backup:main": { provider: "backup", mode: "api_key" },
            "backup:other": { provider: "backup", mode: "api_key" },
          },
          order: { backup: ["backup:main", "backup:other"] },
        },
        agents: {
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: {
            model: {
              primary: "openai/gpt-4.1",
              fallbacks: options.fallbacks ?? ["backup/gpt-4.1"],
            },
            models: {
              "openai/gpt-4.1": loopbackModelRuntime,
              "backup/gpt-4.1": loopbackModelRuntime,
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            openai: loopbackProviderConfig(primary.url),
            backup: loopbackProviderConfig(backup.url),
          },
        },
      };
      await persistAuthProfileBatch({
        profiles: [
          apiKeyProfile("openai:primary", "key-primary"),
          apiKeyProfile("backup:main", "key-backup"),
          apiKeyProfile("backup:other", "key-backup-other"),
        ],
      });
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const storePath = state.statePath("cron", "jobs.json");
      try {
        await run({
          state,
          cfg,
          hits,
          storePath,
          setPrimary: (mode) => {
            primaryMode = mode;
          },
          async reload(job) {
            await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
            clearRuntimeAuthProfileStoreSnapshots();
            const [reloaded] = (await loadCronJobsStore(storePath)).jobs;
            expect(reloaded?.inferenceBinding).toEqual(job.inferenceBinding);
            return reloaded!;
          },
          async run(job) {
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearRuntimeAuthProfileStoreSnapshots();
            return runCronIsolatedAgentTurn({
              occurrence: TEST_SCHEDULED_OCCURRENCE,
              cfg,
              deps: {},
              job,
              deliveryAttemptFence: null,
              message: "Reply.",
              sessionKey: `cron:${job.id}`,
              lane: "cron",
            });
          },
        });
      } finally {
        await resetPreparedModelRuntimeSnapshotsForTest();
        await primary.close();
        await backup.close();
      }
    },
  );
}

function storedJob(id: string, payload: Partial<CronStoredJob["payload"]> = {}): CronStoredJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    delivery: { mode: "none" },
    payload: { kind: "agentTurn", message: "Reply.", lightContext: true, ...payload },
    state: {},
  } as CronStoredJob;
}

async function boundJob(
  cfg: OpenClawConfig,
  id: string,
  options: { recordFallbacks: boolean },
): Promise<CronStoredJob> {
  const model = "openai/gpt-4.1@openai:primary";
  const binding = await captureCronInferenceBinding({ cfg, agentId: "main", model });
  if (!binding) {
    throw new Error("Expected a recorded primary account");
  }
  if (options.recordFallbacks) {
    const { accounts, unrecorded } = await captureCronFallbackInferenceAccounts({
      cfg,
      agentId: "main",
      primaryProvider: binding.provider,
      model,
    });
    expect(unrecorded).toEqual([]);
    binding.fallbackAccounts = accounts;
  }
  return { ...storedJob(id, { model }), inferenceBinding: binding };
}

beforeEach(bindSessionMcpRuntimeTestScheduler);
afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
});

it("fails over to the fallback provider's recorded account when the primary is out of quota", async () => {
  await withFallbackFixture(async ({ cfg, hits, reload, run, state }) => {
    const job = await reload(await boundJob(cfg, "xprov", { recordFallbacks: true }));
    expect(job.inferenceBinding).toMatchObject({
      provider: "openai",
      profileId: "openai:primary",
      source: "user",
      fallbackAccounts: [
        { provider: "backup", profileId: "backup:main", runtime: "openclaw", source: "auto" },
      ],
    });
    // Interactive defaults move to another backup account; the job keeps the recorded one.
    await setAuthProfileOrder({
      agentDir: state.agentDir(),
      provider: "backup",
      order: ["backup:other", "backup:main"],
    });
    await updateAuthProfileStoreWithLock({
      agentDir: state.agentDir(),
      updater(store) {
        store.lastGood = { ...store.lastGood, backup: "backup:other" };
        return true;
      },
    });
    const result = await run(job);
    expect(result.status, result.error).toBe("ok");
    expect(result.summary).toContain("served by backup provider");
    expect(hits.primary).toEqual(["Bearer key-primary"]);
    expect(hits.backup).toEqual(["Bearer key-backup"]);
  });
});

it("keeps refusing a fallback provider without a recorded account (10.10 bindings)", async () => {
  await withFallbackFixture(async ({ cfg, hits, reload, run }) => {
    const job = await reload(await boundJob(cfg, "unrecorded", { recordFallbacks: false }));
    expect(job.inferenceBinding?.fallbackAccounts).toBeUndefined();
    const result = await run(job);
    expect(result.status).toBe("error");
    expect(result.error).toContain("no fallback account is recorded for provider backup");
    expect(result.error).toContain("openclaw doctor --fix");
    expect(hits.primary).toEqual(["Bearer key-primary"]);
    expect(hits.backup).toEqual([]);
  });
});

it.each(["replaced", "removed"] as const)(
  "refuses a %s fallback account only when the chain reaches it",
  async (change) => {
    await withFallbackFixture(async ({ cfg, hits, reload, run, setPrimary }) => {
      const job = await reload(
        await boundJob(cfg, `fallback-${change}`, { recordFallbacks: true }),
      );
      if (change === "replaced") {
        await persistAuthProfileBatch({ profiles: [apiKeyProfile("backup:main", "key-rotated")] });
      } else {
        expect(await removeAuthProfilesAcrossOwnerStores({ profileIds: ["backup:main"] })).toBe(
          true,
        );
      }
      // The primary still runs: a lost fallback account never blocks the job's own account.
      setPrimary("ok");
      const healthy = await run(job);
      expect(healthy.status, healthy.error).toBe("ok");
      expect(healthy.summary).toContain("served by primary provider");
      // Once the primary fails, the lost fallback account is refused instead of replaced.
      setPrimary("quota");
      const failed = await run(job);
      expect(failed.status).toBe("error");
      expect(failed.error).toContain(
        change === "replaced"
          ? "account backup:main on runtime openclaw was replaced"
          : "account backup:main on runtime openclaw was removed or signed out",
      );
      expect(hits.primary).toEqual(["Bearer key-primary", "Bearer key-primary"]);
      expect(hits.backup).toEqual([]);
    });
  },
);

it("records only fallback providers from the job's own chain", async () => {
  await withFallbackFixture(
    async ({ cfg }) => {
      const explicit = await captureCronFallbackInferenceAccounts({
        cfg,
        agentId: "main",
        primaryProvider: "openai",
        model: "openai/gpt-4.1@openai:primary",
        fallbacks: [],
      });
      expect(explicit).toEqual({ accounts: [], unrecorded: [] });
      const inherited = await captureCronFallbackInferenceAccounts({
        cfg,
        agentId: "main",
        primaryProvider: "openai",
      });
      expect(inherited.accounts.map((account) => account.profileId)).toEqual(["backup:main"]);
    },
    { fallbacks: ["openai/gpt-4.1", "backup/gpt-4.1"] },
  );
});

it("reports a fallback provider without a stored account instead of failing the capture", async () => {
  await withFallbackFixture(async ({ cfg }) => {
    expect(await removeAuthProfilesAcrossOwnerStores({ profileIds: ["backup:main"] })).toBe(true);
    expect(await removeAuthProfilesAcrossOwnerStores({ profileIds: ["backup:other"] })).toBe(true);
    clearRuntimeAuthProfileStoreSnapshots();
    const captured = await captureCronFallbackInferenceAccounts({
      cfg: {
        ...cfg,
        auth: { profiles: { "openai:primary": cfg.auth!.profiles!["openai:primary"]! } },
      },
      agentId: "main",
      primaryProvider: "openai",
    });
    expect(captured.accounts).toEqual([]);
    expect(captured.unrecorded).toEqual([
      expect.objectContaining({ provider: "backup", model: "backup/gpt-4.1" }),
    ]);
  });
});

it("records fallback accounts through Gateway create/update and fails over after a restart", async () => {
  await withFallbackFixture(async ({ cfg, hits, state, storePath }) => {
    const { CronService } = await import("./service.js");
    const { createNoopLogger } = await import("./service.test-harness.js");
    const { createTestGatewayScheduler } = await import("../test-utils/gateway-scheduler-clock.js");
    const { createDirectChatContext } =
      await import("../gateway/server-chat.agent-events.test-helpers.js");
    const { cronHandlers } = await import("../gateway/server-methods/cron.js");
    const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
    const { closeOpenClawStateDatabaseAsync } = await import("../state/openclaw-state-db.js");
    const finished: Array<{ status?: string; error?: string; summary?: string }> = [];
    const makeCron = () =>
      new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent() {},
        onEvent(event) {
          if (event.action === "finished") {
            finished.push(event);
          }
        },
        runIsolatedAgentJob: async (params) => {
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearRuntimeAuthProfileStoreSnapshots();
          return runCronIsolatedAgentTurn({
            ...params,
            cfg,
            deps: {},
            sessionKey: `cron:${params.job.id}`,
          });
        },
      });
    let cron = makeCron();
    async function invoke(method: "cron.add" | "cron.update", params: Record<string, unknown>) {
      const respond = vi.fn();
      await cronHandlers[method]!({
        req: { type: "req", id: `fallback-${method}`, method, params },
        params,
        respond,
        context: createDirectChatContext({
          cron,
          cronStorePath: storePath,
          getRuntimeConfig: () => cfg,
        }),
        client: null,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0]?.[2])).toBe(true);
      return respond.mock.calls[0]?.[1] as Record<string, unknown>;
    }
    const readBinding = async () => (await loadCronJobsStore(storePath)).jobs[0]?.inferenceBinding;
    try {
      const created = await invoke("cron.add", {
        name: "cross-provider",
        enabled: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Reply.",
          model: "openai/gpt-4.1@openai:primary",
          lightContext: true,
          toolsAllow: [],
        },
        delivery: { mode: "none" },
      });
      // Public responses never expose private account metadata.
      expect(JSON.stringify(created)).not.toContain("fallbackAccounts");
      expect(JSON.stringify(created)).not.toContain("backup:main");
      const id = String(created.id);
      expect(await readBinding()).toMatchObject({
        profileId: "openai:primary",
        fallbackAccounts: [{ provider: "backup", profileId: "backup:main" }],
      });
      // Removing the job's fallbacks drops their accounts; restoring them records them again.
      await invoke("cron.update", {
        id,
        patch: { payload: { kind: "agentTurn", fallbacks: [] } },
      });
      expect(await readBinding()).toMatchObject({ profileId: "openai:primary" });
      expect((await readBinding())?.fallbackAccounts).toBeUndefined();
      await invoke("cron.update", {
        id,
        patch: { payload: { kind: "agentTurn", fallbacks: ["backup/gpt-4.1"] } },
      });
      expect(await readBinding()).toMatchObject({
        profileId: "openai:primary",
        fallbackAccounts: [{ provider: "backup", profileId: "backup:main" }],
      });
      // Restart: close every database and rebuild the service from SQLite alone.
      cron.stop();
      await cron.waitForIdle();
      clearRuntimeAuthProfileStoreSnapshots();
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
      await setAuthProfileOrder({
        agentDir: state.agentDir(),
        provider: "backup",
        order: ["backup:other", "backup:main"],
      });
      cron = makeCron();
      await expect(cron.run(id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(finished).toHaveLength(1);
      expect(finished[0]?.status, finished[0]?.error).toBe("ok");
      expect(hits.primary).toEqual(["Bearer key-primary"]);
      expect(hits.backup).toEqual(["Bearer key-backup"]);
    } finally {
      cron.stop();
      await cron.waitForIdle();
    }
  });
});

it.each([
  ["unbound legacy job", "two eligible backup accounts"],
  ["10.10 binding", "one eligible backup account"],
] as const)(
  "Doctor records fallback accounts for a %s (%s) and the job then fails over",
  async (kind) => {
    await withFallbackFixture(async ({ cfg, hits, run, storePath }) => {
      const { maybeRepairCronInferenceBindings } =
        await import("../commands/doctor/cron/inference-binding-migration.js");
      const { withDoctorConfigMaintenance } =
        await import("../commands/doctor-config-flow.test-support.js");
      if (kind === "10.10 binding") {
        // Spec D2: Doctor fills a bound job's fallback only when exactly one account fits.
        expect(await removeAuthProfilesAcrossOwnerStores({ profileIds: ["backup:other"] })).toBe(
          true,
        );
        clearRuntimeAuthProfileStoreSnapshots();
      }
      const job =
        kind === "unbound legacy job"
          ? storedJob("doctor-legacy")
          : await boundJob(cfg, "doctor-bound", { recordFallbacks: false });
      await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
      const before = (await loadCronJobsStore(storePath)).jobs[0];

      const lint = await maybeRepairCronInferenceBindings({ cfg, shouldRepair: false });
      expect(lint.changes).toEqual([]);
      expect(lint.warnings.join("\n")).toContain(
        kind === "unbound legacy job"
          ? "Run openclaw doctor --fix to record it"
          : "fallbacks on backup",
      );
      expect((await loadCronJobsStore(storePath)).jobs[0]).toEqual(before);

      const fixed = await withDoctorConfigMaintenance(() =>
        maybeRepairCronInferenceBindings({ cfg, shouldRepair: true }),
      );
      expect(fixed.warnings).toEqual([]);
      const [repaired] = (await loadCronJobsStore(storePath)).jobs;
      expect(repaired?.inferenceBinding).toMatchObject({
        provider: "openai",
        profileId: "openai:primary",
        fallbackAccounts: [{ provider: "backup", profileId: "backup:main", source: "auto" }],
      });
      if (kind !== "unbound legacy job") {
        // The recorded primary account is never rewritten.
        const { fallbackAccounts: _added, ...primary } = repaired!.inferenceBinding!;
        expect(primary).toEqual(job.inferenceBinding);
      }
      // Idempotent: a second run has nothing left to record.
      const again = await withDoctorConfigMaintenance(() =>
        maybeRepairCronInferenceBindings({ cfg, shouldRepair: true }),
      );
      expect(again.changes).toEqual([]);
      expect((await loadCronJobsStore(storePath)).jobs[0]).toEqual(repaired);

      const result = await run(repaired!);
      expect(result.status, result.error).toBe("ok");
      expect(result.summary).toContain("served by backup provider");
      expect(hits.backup).toEqual(["Bearer key-backup"]);
    });
  },
);

it("Doctor never chooses among several eligible fallback accounts for an already-bound job", async () => {
  await withFallbackFixture(async ({ cfg, hits, run, state, storePath }) => {
    const { maybeRepairCronInferenceBindings } =
      await import("../commands/doctor/cron/inference-binding-migration.js");
    const { withDoctorConfigMaintenance } =
      await import("../commands/doctor-config-flow.test-support.js");
    const job = await boundJob(cfg, "doctor-ambiguous", { recordFallbacks: false });
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    // The order flipped after the job was bound; current order is not the owner's consent.
    await setAuthProfileOrder({
      agentDir: state.agentDir(),
      provider: "backup",
      order: ["backup:other", "backup:main"],
    });
    const fixed = await withDoctorConfigMaintenance(() =>
      maybeRepairCronInferenceBindings({ cfg, shouldRepair: true }),
    );
    const warnings = fixed.warnings.join("\n");
    expect(warnings).toContain("several accounts are eligible (backup:main, backup:other)");
    expect(warnings).toContain("--fallbacks backup/gpt-4.1@<profileId>");
    const [unchanged] = (await loadCronJobsStore(storePath)).jobs;
    expect(unchanged?.inferenceBinding).toEqual(job.inferenceBinding);
    const result = await run(unchanged!);
    expect(result.status).toBe("error");
    expect(hits.backup).toEqual([]);
  });
});

it("honors an explicit fallback account written as model@profile", async () => {
  await withFallbackFixture(async ({ cfg, hits, reload, run }) => {
    const model = "openai/gpt-4.1@openai:primary";
    const fallbacks = ["backup/gpt-4.1@backup:other"];
    const binding = (await captureCronInferenceBinding({ cfg, agentId: "main", model }))!;
    const { accounts, unrecorded } = await captureCronFallbackInferenceAccounts({
      cfg,
      agentId: "main",
      primaryProvider: "openai",
      model,
      fallbacks,
    });
    expect(unrecorded).toEqual([]);
    // Default order prefers backup:main; the owner's explicit choice wins and is marked as theirs.
    expect(accounts).toMatchObject([
      { provider: "backup", profileId: "backup:other", source: "user" },
    ]);
    binding.fallbackAccounts = accounts;
    const job = await reload({
      ...storedJob("explicit", { model, fallbacks }),
      inferenceBinding: binding,
    });
    const result = await run(job);
    expect(result.status, result.error).toBe("ok");
    expect(hits.backup).toEqual(["Bearer key-backup-other"]);
  });
});

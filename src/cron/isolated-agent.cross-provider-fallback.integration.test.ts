import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import {
  removeAuthProfilesAcrossOwnerStores,
  setAuthProfileOrder,
} from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
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
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent/run.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

// A job's recorded account (#172590) governs only its own provider. Configured fallbacks on
// other providers select credentials live, like an interactive run, so cross-provider failover
// works again (#192009, #192463). Only provider HTTP is faked, on loopback.

type Fixture = {
  state: OpenClawTestState;
  cfg: OpenClawConfig;
  hits: { primary: string[]; backup: string[] };
  setPrimary: (mode: "quota" | "ok") => void;
  run: (job: CronStoredJob) => ReturnType<typeof runCronIsolatedAgentTurn>;
  reload: (job: CronStoredJob) => Promise<CronStoredJob>;
};

function withFallbackFixture(run: (fixture: Fixture) => Promise<void>) {
  return withOpenClawTestState(
    { label: "cron-cross-provider-fallback", env: { OPENAI_API_KEY: undefined } },
    async (state) => {
      installPrivateUpdateHandoffStore(state.root);
      let primaryMode: "quota" | "ok" = "quota";
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
            model: { primary: "openai/gpt-4.1", fallbacks: ["backup/gpt-4.1"] },
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

/** A job exactly as 2026.10.10 and 2026.11.2 store it: one recorded account, no fallback state. */
async function boundJob(
  cfg: OpenClawConfig,
  id: string,
  payload: Partial<CronStoredJob["payload"]> = { model: "openai/gpt-4.1@openai:primary" },
): Promise<CronStoredJob> {
  const binding = await captureCronInferenceBinding({
    cfg,
    agentId: "main",
    model: "openai/gpt-4.1@openai:primary",
  });
  if (!binding) {
    throw new Error("Expected a recorded primary account");
  }
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
    inferenceBinding: binding,
  } as CronStoredJob;
}

beforeEach(bindSessionMcpRuntimeTestScheduler);
afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
});

it("fails over to another provider's live account when the primary is out of quota", async () => {
  await withFallbackFixture(async ({ cfg, hits, reload, run, state }) => {
    const job = await reload(await boundJob(cfg, "xprov"));
    expect(job.inferenceBinding).toMatchObject({ provider: "openai", profileId: "openai:primary" });
    const first = await run(job);
    expect(first.status, first.error).toBe("ok");
    expect(first.summary).toContain("served by backup provider");
    // The fallback follows that provider's live account order, like an interactive run.
    await setAuthProfileOrder({
      agentDir: state.agentDir(),
      provider: "backup",
      order: ["backup:other", "backup:main"],
    });
    const second = await run(job);
    expect(second.status, second.error).toBe("ok");
    // The quota failure puts the primary account in cooldown, so the second run may skip it;
    // it never sends another account's credential to the primary provider.
    expect(hits.primary.every((auth) => auth === "Bearer key-primary")).toBe(true);
    expect(hits.backup).toEqual(["Bearer key-backup", "Bearer key-backup-other"]);
    // Nothing new is recorded; the binding is exactly what the job stored.
    expect((await reload(job)).inferenceBinding).toEqual(job.inferenceBinding);
  });
});

it.each(["replaced", "removed", "signed out"] as const)(
  "still fails over when the recorded account was %s",
  async (change) => {
    await withFallbackFixture(async ({ cfg, hits, reload, run, setPrimary }) => {
      const job = await reload(await boundJob(cfg, `primary-${change}`));
      if (change === "replaced") {
        await persistAuthProfileBatch({ profiles: [apiKeyProfile("openai:primary", "key-new")] });
      } else {
        expect(await removeAuthProfilesAcrossOwnerStores({ profileIds: ["openai:primary"] })).toBe(
          true,
        );
        if (change === "signed out") {
          // `openclaw models auth logout` also drops the profile from config; the fallback must
          // not inherit the gone account as its own selection.
          delete cfg.auth!.profiles!["openai:primary"];
          setRuntimeConfigSnapshot(cfg);
        }
      }
      // A healthy primary would still be refused: the job never adopts a changed account.
      setPrimary("ok");
      const result = await run(job);
      expect(result.status, result.error).toBe("ok");
      expect(result.summary).toContain("served by backup provider");
      expect(hits.primary).toEqual([]);
      expect(hits.backup).toEqual(["Bearer key-backup"]);
    });
  },
);

it("runs on the new default provider when a job without its own model follows the default", async () => {
  await withFallbackFixture(async ({ cfg, hits, reload, run }) => {
    const job = await reload(await boundJob(cfg, "default-moves", {}));
    cfg.agents!.defaults!.model = { primary: "backup/gpt-4.1", fallbacks: [] };
    setRuntimeConfigSnapshot(cfg);
    const result = await run(job);
    expect(result.status, result.error).toBe("ok");
    expect(result.summary).toContain("served by backup provider");
    expect(hits.primary).toEqual([]);
    expect(hits.backup).toEqual(["Bearer key-backup"]);
  });
});

it("keeps the recorded provider on its recorded account", async () => {
  await withFallbackFixture(async ({ cfg, hits, reload, run, setPrimary }) => {
    const job = await reload(await boundJob(cfg, "primary-strict"));
    await persistAuthProfileBatch({
      profiles: [apiKeyProfile("openai:other", "key-openai-other")],
    });
    cfg.auth!.profiles!["openai:other"] = { provider: "openai", mode: "api_key" };
    cfg.auth!.order = { ...cfg.auth!.order, openai: ["openai:other", "openai:primary"] };
    setRuntimeConfigSnapshot(cfg);
    setPrimary("ok");
    const result = await run(job);
    expect(result.status, result.error).toBe("ok");
    expect(hits.primary).toEqual(["Bearer key-primary"]);
  });
});

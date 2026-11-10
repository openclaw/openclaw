// Spec regressions: a rate-limit cooldown never picks a fallback account, and a refused
// fallback candidate is skipped while later recorded candidates still run (spec I1, I6/D3).
import { afterEach, beforeEach, expect, it } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store-runtime.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../agents/ai-transport-runtime-host.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
import type { CronStoredJob } from "./types.js";

beforeEach(bindSessionMcpRuntimeTestScheduler);
afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
});

function baseConfig(
  state: { agentDir(): string; workspaceDir: string },
  urls: Record<string, string>,
) {
  const providers = Object.fromEntries(
    Object.entries(urls).map(([id, url]) => [id, loopbackProviderConfig(url)]),
  );
  const cfg: OpenClawConfig = {
    plugins: { allow: ["openai"], slots: { memory: "none" } },
    skills: { load: { watch: false } },
    tools: { deny: ["*"] },
    auth: {
      profiles: {
        "openai:primary": { provider: "openai", mode: "api_key" },
        "backup:main": { provider: "backup", mode: "api_key" },
        "backup:other": { provider: "backup", mode: "api_key" },
        "third:main": { provider: "third", mode: "api_key" },
      },
      order: { backup: ["backup:main", "backup:other"] },
    },
    agents: {
      entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
      defaults: {
        model: { primary: "openai/gpt-4.1", fallbacks: ["backup/gpt-4.1", "third/gpt-4.1"] },
        models: Object.fromEntries(
          Object.keys(urls).map((id) => [`${id}/gpt-4.1`, loopbackModelRuntime]),
        ),
      },
    },
    models: { mode: "replace", providers },
  };
  return cfg;
}

it("records the same fallback account while the first eligible account is in a rate-limit cooldown", async () => {
  await withOpenClawTestState(
    { label: "cron-fallback-cooldown", env: { OPENAI_API_KEY: undefined } },
    async (state) => {
      installPrivateUpdateHandoffStore(state.root);
      const cfg = baseConfig(state, {
        openai: "http://127.0.0.1:9/v1",
        backup: "http://127.0.0.1:9/v1",
        third: "http://127.0.0.1:9/v1",
      });
      await persistAuthProfileBatch({
        profiles: [
          apiKeyProfile("openai:primary", "k1"),
          apiKeyProfile("backup:main", "k2"),
          apiKeyProfile("backup:other", "k3"),
          apiKeyProfile("third:main", "k4"),
        ],
      });
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const capture = async () =>
        (
          await captureCronFallbackInferenceAccounts({
            cfg,
            agentId: "main",
            primaryProvider: "openai",
          })
        ).accounts.find((a) => a.provider === "backup")?.profileId;
      const before = await capture();
      await updateAuthProfileStoreWithLock({
        agentDir: state.agentDir(),
        updater(store) {
          store.usageStats = {
            ...store.usageStats,
            "backup:main": { cooldownUntil: Date.now() + 3_600_000, cooldownReason: "rate_limit" },
          };
          return true;
        },
      });
      clearRuntimeAuthProfileStoreSnapshots();
      const during = await capture();
      expect(before).toBe("backup:main");
      expect(during).toBe("backup:main");
    },
  );
});

it("skips a fallback without a recorded account and runs the next recorded candidate", async () => {
  await withOpenClawTestState(
    { label: "cron-fallback-skip", env: { OPENAI_API_KEY: undefined } },
    async (state) => {
      installPrivateUpdateHandoffStore(state.root);
      const hits: string[] = [];
      const servers = await Promise.all(
        (["openai", "backup", "third"] as const).map((id) =>
          listenLoopbackProvider((req, res) => {
            req.resume();
            hits.push(id);
            if (id === "openai") {
              res.writeHead(429, { "content-type": "application/json" });
              res.end(QUOTA_EXHAUSTED_BODY);
              return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(completedSse("gpt-4.1", `served by ${id}`));
          }),
        ),
      );
      try {
        const cfg = baseConfig(state, {
          openai: servers[0]!.url,
          backup: servers[1]!.url,
          third: servers[2]!.url,
        });
        await persistAuthProfileBatch({
          profiles: [
            apiKeyProfile("openai:primary", "k1"),
            apiKeyProfile("backup:main", "k2"),
            apiKeyProfile("third:main", "k4"),
          ],
        });
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const model = "openai/gpt-4.1@openai:primary";
        const binding = (await captureCronInferenceBinding({ cfg, agentId: "main", model }))!;
        const { accounts } = await captureCronFallbackInferenceAccounts({
          cfg,
          agentId: "main",
          primaryProvider: "openai",
          model,
        });
        // Only the third provider is recorded; backup stays unrecorded.
        binding.fallbackAccounts = accounts.filter((a) => a.provider === "third");
        const job = {
          id: "v8",
          name: "v8",
          agentId: "main",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: "Reply.", lightContext: true, model },
          state: {},
          inferenceBinding: binding,
        } as CronStoredJob;
        const result = await runCronIsolatedAgentTurn({
          occurrence: TEST_SCHEDULED_OCCURRENCE,
          cfg,
          deps: {},
          job,
          deliveryAttemptFence: null,
          message: "Reply.",
          sessionKey: "cron:v8",
          lane: "cron",
        });
        expect(result.status, result.error).toBe("ok");
        expect(result.provider).toBe("third");
        expect(hits).toEqual(["openai", "third"]);
      } finally {
        await resetPreparedModelRuntimeSnapshotsForTest();
        await Promise.all(servers.map((s) => s.close()));
      }
    },
  );
});

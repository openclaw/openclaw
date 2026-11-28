import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../llm/ai-transport-host.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { resetSessionControllerStateForTest } from "../sessions/session-lifecycle-admission.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  apiKeyProfile,
  listenLoopbackProvider,
  loopbackModelRuntime,
  loopbackProviderConfig,
} from "./cross-provider-fallback.test-support.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent/run.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { runCronSessionTurn } from "./session-run.js";
import type { CronStoredJob } from "./types.js";

// A provider's multi-day limit reaches cron as its reset time on both run paths, so the
// scheduler can wait for it. Provider HTTP is loopback only.

await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

const RESET_SECONDS = 6 * 24 * 60 * 60;
const sessionKey = "agent:main:rate-limited-target";

beforeEach(bindSessionMcpRuntimeTestScheduler);
afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  resetSessionControllerStateForTest();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it.each(["session-target", "isolated"] as const)(
  "reports the provider's multi-day reset to the scheduler (%s)",
  async (path) => {
    await withOpenClawTestState(
      {
        label: `cron-rate-limit-reset-${path}`,
        env: {
          OPENAI_API_KEY: undefined,
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          ALL_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          all_proxy: undefined,
          NODE_USE_ENV_PROXY: undefined,
        },
      },
      async (state) => {
        installPrivateUpdateHandoffStore(state.root);
        let requests = 0;
        const provider = await listenLoopbackProvider((req, res) => {
          req.resume();
          requests += 1;
          res.writeHead(429, {
            "content-type": "application/json",
            "retry-after": String(RESET_SECONDS),
          });
          res.end(
            JSON.stringify({
              error: {
                message: "This request would exceed your account's rate limit.",
                type: "rate_limit_error",
              },
            }),
          );
        });
        try {
          const cfg: OpenClawConfig = {
            plugins: { allow: ["openai"], slots: { memory: "none" } },
            skills: { load: { watch: false } },
            tools: { deny: ["*"] },
            auth: { profiles: { "openai:main": { provider: "openai", mode: "api_key" } } },
            agents: {
              entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
              defaults: {
                model: { primary: "openai/gpt-4.1" },
                models: { "openai/gpt-4.1": loopbackModelRuntime },
              },
            },
            models: {
              mode: "replace",
              providers: { openai: loopbackProviderConfig(provider.url) },
            },
          };
          await persistAuthProfileBatch({ profiles: [apiKeyProfile("openai:main", "key-main")] });
          await state.writeConfig(cfg);
          setRuntimeConfigSnapshot(cfg);
          clearRuntimeAuthProfileStoreSnapshots();
          const model = "openai/gpt-4.1@openai:main";
          const binding = await captureCronInferenceBinding({ cfg, agentId: "main", model });
          if (!binding) {
            throw new Error("Expected a recorded account");
          }
          const job: CronStoredJob = {
            ...makeCronJob({
              id: `rate-limited-${path}`,
              agentId: "main",
              ...(path === "session-target"
                ? { sessionTarget: `session:${sessionKey}`, wakeMode: "now" as const }
                : {}),
              delivery: { mode: "none" },
              payload: { kind: "agentTurn", message: "Reply.", model },
            }),
            inferenceBinding: binding,
          };
          const startedAt = Date.now();
          let result;
          if (path === "session-target") {
            await replaceSessionEntry(
              { agentId: "main", sessionKey },
              { sessionId: "rate-limited", updatedAt: startedAt, sessionStartedAt: startedAt },
            );
            result = await runCronSessionTurn({
              occurrence: TEST_SCHEDULED_OCCURRENCE,
              cfg,
              agentId: "main",
              sessionKey,
              job,
              text: "Reply.",
              admissionSource: "operator-schedule",
              deliveryAttemptFence: null,
              abortSignal: new AbortController().signal,
              assertCurrent() {},
            });
          } else {
            result = await runCronIsolatedAgentTurn({
              occurrence: TEST_SCHEDULED_OCCURRENCE,
              cfg,
              deps: {},
              job,
              deliveryAttemptFence: null,
              message: "Reply.",
              sessionKey: `cron:${job.id}`,
              lane: "cron",
            });
          }
          expect(result.status).toBe("error");
          // One provider request: a long limit is not retried within the run.
          expect(requests, result.error).toBe(1);
          expect(result.rateLimitResetAt).toBeGreaterThanOrEqual(startedAt + RESET_SECONDS * 1000);
          expect(result.rateLimitResetAt).toBeLessThanOrEqual(Date.now() + RESET_SECONDS * 1000);
        } finally {
          await resetPreparedModelRuntimeSnapshotsForTest();
          await provider.close();
        }
      },
    );
  },
);

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../test/helpers/cron/service-regression-fixtures.js";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import "../llm/ai-transport-host.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { resetSessionControllerStateForTest } from "../sessions/session-lifecycle-admission.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  apiKeyProfile,
  loopbackModelRuntime,
  loopbackProviderConfig,
} from "./cross-provider-fallback.test-support.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import { resolveCronRunErrorReason } from "./run-error-reason.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { applyJobResult } from "./service/timer-outcomes.js";
import { runCronSessionTurn } from "./session-run.js";

await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);
beforeEach(bindSessionMcpRuntimeTestScheduler);
afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  resetSessionControllerStateForTest();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it("retains a provider server error through accepted session continuation and rearms the one-shot", async () => {
  await withOpenClawTestState(
    {
      label: "cron-session-transient",
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
      // Exercise the terminal handoff, not the inner provider retry budget.
      await fs.mkdir(path.join(state.workspaceDir, ".openclaw"), { recursive: true });
      await fs.writeFile(
        path.join(state.workspaceDir, ".openclaw", "settings.json"),
        JSON.stringify({ retry: { provider: { maxRetries: 0 } } }),
      );
      let requests = 0;
      const provider = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          http.createServer((req, res) => {
            req.resume();
            requests++;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(
              'data: {"type":"response.failed","response":{"id":"resp_failure","status":"failed","error":{"code":"server_error","message":"Synthetic upstream failure"}}}\n\n',
            );
          }),
      });
      const terminals: Record<string, unknown>[] = [];
      const unsubscribe = onAgentEvent((event) => {
        if (event.stream === "lifecycle" && event.data.executionSettled) {
          terminals.push(event.data);
        }
      });
      try {
        const cfg: OpenClawConfig = {
          plugins: { allow: ["openai"], slots: { memory: "none" } },
          skills: { load: { watch: false } },
          tools: { deny: ["*"] },
          auth: { profiles: { "openai:test": { provider: "openai", mode: "api_key" } } },
          agents: {
            entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
            defaults: {
              model: { primary: "openai/gpt-4.1", fallbacks: [] },
              models: { "openai/gpt-4.1": loopbackModelRuntime },
            },
          },
          models: {
            mode: "replace",
            providers: {
              openai: loopbackProviderConfig(`http://127.0.0.1:${provider.claim.port}/v1`),
            },
          },
        };
        await persistAuthProfileBatch({
          profiles: [apiKeyProfile("openai:test", "synthetic-key")],
        });
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const sessionKey = "agent:main:continuation";
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          { sessionId: "continuation-test", updatedAt: Date.now(), sessionStartedAt: Date.now() },
        );
        const startedAt = Date.now();
        const model = "openai/gpt-4.1@openai:test";
        const inferenceBinding = await captureCronInferenceBinding({ cfg, agentId: "main", model });
        if (!inferenceBinding) {
          throw new Error("Expected a recorded inference account");
        }
        const job = {
          ...makeCronJob({
            id: "transient-continuation",
            agentId: "main",
            sessionTarget: `session:${sessionKey}`,
            wakeMode: "now",
            delivery: { mode: "none" },
            schedule: { kind: "at", at: new Date(startedAt).toISOString() },
            state: { runningAtMs: startedAt, nextRunAtMs: startedAt },
            payload: { kind: "agentTurn", message: "Continue the report.", model },
          }),
          inferenceBinding,
        };
        const result = await runCronSessionTurn({
          occurrence: TEST_SCHEDULED_OCCURRENCE,
          cfg,
          agentId: "main",
          sessionKey,
          job,
          text: "Continue the report.",
          admissionSource: "operator-schedule",
          deliveryAttemptFence: null,
          abortSignal: new AbortController().signal,
          assertCurrent() {},
        });
        expect(requests, JSON.stringify({ result, terminals })).toBeGreaterThan(0);
        expect(result.executionStarted).toBe(true);
        expect(result.status).toBe("error");
        expect(result.error).toContain("The AI service is having trouble");
        expect(result.errorClassification).toEqual({ kind: "reason", reason: "server_error" });
        expect(terminals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              errorObservation: expect.objectContaining({ failoverReason: "server_error" }),
            }),
          ]),
        );
        const endedAt = Date.now();
        const cron = createCronRegressionState({
          storePath: state.statePath("cron", "jobs.json"),
          nowMs: () => endedAt,
          runIsolatedAgentJob: async () => ({ status: "ok" }),
        });
        cron.store = { version: 1, jobs: [job] };
        applyJobResult(
          cron,
          job,
          {
            ...result,
            startedAt,
            endedAt,
            errorReason: resolveCronRunErrorReason(
              result.error,
              result.provider,
              result.errorClassification,
            ),
          },
          { deferredNotifications: [] },
        );
        expect(job.enabled).toBe(true);
        expect(job.state.lastErrorReason).toBe("server_error");
        expect(job.state.nextRunAtMs).toBe(endedAt + 30_000);
      } finally {
        unsubscribe();
        await provider.releaseListener();
        await provider.claim.release();
      }
    },
  );
});

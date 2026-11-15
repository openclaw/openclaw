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
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../llm/ai-transport-host.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { resetSessionControllerStateForTest } from "../sessions/session-lifecycle-admission.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  apiKeyProfile,
  completedSse,
  listenLoopbackProvider,
  loopbackModelRuntime,
  loopbackProviderConfig,
  QUOTA_EXHAUSTED_BODY,
} from "./cross-provider-fallback.test-support.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { runCronSessionTurn } from "./session-run.js";
import type { CronStoredJob } from "./types.js";

// Session-target jobs run through the reply runner rather than the isolated executor; both
// must honor each provider's recorded account on fallback. Provider HTTP is loopback only.

await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

const sessionKey = "agent:main:fallback-target";

beforeEach(bindSessionMcpRuntimeTestScheduler);
afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  resetSessionControllerStateForTest();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it.each(["live", "primary-revoked"] as const)(
  "a session-target job fails over to another provider's live account (%s)",
  async (kind) => {
    await withOpenClawTestState(
      { label: "cron-session-cross-provider", env: { OPENAI_API_KEY: undefined } },
      async (state) => {
        installPrivateUpdateHandoffStore(state.root);
        const hits = { primary: [] as string[], backup: [] as string[] };
        const primary = await listenLoopbackProvider((req, res) => {
          req.resume();
          hits.primary.push(String(req.headers.authorization));
          res.writeHead(429, { "content-type": "application/json" });
          res.end(QUOTA_EXHAUSTED_BODY);
        });
        const backup = await listenLoopbackProvider((req, res) => {
          req.resume();
          hits.backup.push(String(req.headers.authorization));
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(completedSse("gpt-4.1", "served by backup provider"));
        });
        try {
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
          await replaceSessionEntry(
            { agentId: "main", sessionKey },
            {
              sessionId: "fallback-conversation",
              updatedAt: Date.now(),
              sessionStartedAt: Date.now(),
            },
          );
          const model = "openai/gpt-4.1@openai:primary";
          const binding = await captureCronInferenceBinding({ cfg, agentId: "main", model });
          if (!binding) {
            throw new Error("Expected a recorded primary account");
          }
          if (kind === "primary-revoked") {
            expect(
              await removeAuthProfilesAcrossOwnerStores({ profileIds: ["openai:primary"] }),
            ).toBe(true);
          }
          // The fallback provider records no account, so it follows its live order.
          await setAuthProfileOrder({
            agentDir: state.agentDir(),
            provider: "backup",
            order: ["backup:other", "backup:main"],
          });
          clearRuntimeAuthProfileStoreSnapshots();
          const job: CronStoredJob = {
            ...makeCronJob({
              id: "session-fallback",
              agentId: "main",
              sessionTarget: `session:${sessionKey}`,
              wakeMode: "now",
              delivery: { mode: "none" },
              payload: { kind: "agentTurn", message: "Reply.", model },
            }),
            inferenceBinding: binding,
          };
          const result = await runCronSessionTurn({
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
          // A removed recorded account refuses only its own candidate; it is never replaced.
          expect(hits.primary).toEqual(kind === "live" ? ["Bearer key-primary"] : []);
          expect(result.status, result.error).toBe("ok");
          expect(hits.backup).toEqual(["Bearer key-backup-other"]);
        } finally {
          await resetPreparedModelRuntimeSnapshotsForTest();
          await primary.close();
          await backup.close();
        }
      },
    );
  },
);

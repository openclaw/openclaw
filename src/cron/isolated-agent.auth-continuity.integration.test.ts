import { zstdDecompressSync } from "node:zlib";
import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { setAuthProfileOrder } from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store-runtime.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../llm/ai-transport-host.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent/run.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

const platformId = "openai:platform";
const subscriptionId = "openai:subscription";
const otherPlatformId = "openai:other-platform";
const otherSubscriptionId = "openai:other-subscription";
const platformKey = "synthetic-platform-key";
const subscriptionToken = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }),
  ).toString("base64url"),
  "synthetic-signature",
].join(".");

function completedResponse(model: string): Response {
  const item = {
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "same authorized account", annotations: [] }],
  };
  const response = { id: "resp_synthetic", model, status: "in_progress", output: [] };
  const events = [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "same authorized account",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(bindSessionMcpRuntimeTestScheduler);

afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
});

describe("persisted cron inference identity through the real embedded runner", () => {
  it.each([
    {
      mode: "API key",
      profileId: platformId,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      credential: platformKey,
    },
    {
      mode: "OAuth",
      profileId: subscriptionId,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      credential: subscriptionToken,
    },
  ] as const)(
    "keeps the creator's $mode account across fresh runs and default changes",
    async ({ profileId, api, baseUrl, credential }) => {
      await withOpenClawTestState(
        {
          label: "cron-real-auth-continuity",
          env: {
            OPENAI_API_KEY: undefined,
            OPENAI_OAUTH_TOKEN: undefined,
            OPENAI_BASE_URL: undefined,
          },
        },
        async (state) => {
          installPrivateUpdateHandoffStore(state.root);
          // These are the only substituted boundaries: serialized provider HTTP and a
          // fail-closed guard for any unexpected network request. Auth, cron, model
          // planning, embedded attempts, AgentCore and response parsing stay real.
          const requests: Array<{
            url: string;
            authorization: string | null;
            account: string | null;
            model: unknown;
          }> = [];
          const providerFetch: typeof fetch = async (input, init) => {
            const request = new Request(input, init);
            if (request.url !== `${baseUrl}/responses` || request.method !== "POST") {
              throw new Error(`Unexpected external I/O in cron credential fixture: ${request.url}`);
            }
            const bytes = Buffer.from(await request.arrayBuffer());
            const json =
              request.headers.get("content-encoding") === "zstd"
                ? zstdDecompressSync(bytes).toString("utf8")
                : bytes.toString("utf8");
            const body: unknown = JSON.parse(json);
            if (
              !body ||
              typeof body !== "object" ||
              !("model" in body) ||
              typeof body.model !== "string"
            ) {
              throw new Error("Expected a serialized provider model request");
            }
            requests.push({
              url: request.url,
              authorization: request.headers.get("authorization"),
              account: request.headers.get("chatgpt-account-id"),
              model: body.model,
            });
            return completedResponse(body.model);
          };
          vi.spyOn(globalThis, "fetch").mockImplementation(providerFetch);
          vi.spyOn(getAiTransportHost(), "buildModelFetch").mockReturnValue(providerFetch);
          const other = profileId === platformId ? otherPlatformId : otherSubscriptionId;
          function config(model: string, selected?: string): OpenClawConfig {
            const preferred = selected ?? profileId;
            return {
              agents: {
                entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
                defaults: {
                  model: `openai/${model}${selected ? `@${selected}` : ""}`,
                  models: {
                    "openai/gpt-4.1": {
                      agentRuntime: { id: "openclaw" },
                      params: { transport: "sse" },
                    },
                    "openai/gpt-4o": {
                      agentRuntime: { id: "openclaw" },
                      params: { transport: "sse" },
                    },
                  },
                },
              },
              auth: {
                profiles: {
                  [platformId]: { provider: "openai", mode: "api_key" },
                  [subscriptionId]: { provider: "openai", mode: "oauth" },
                  [otherPlatformId]: { provider: "openai", mode: "api_key" },
                  [otherSubscriptionId]: { provider: "openai", mode: "oauth" },
                },
                order: {
                  openai: [preferred, preferred === platformId ? subscriptionId : platformId],
                },
              },
              models: {
                mode: "replace",
                providers: {
                  openai: {
                    api,
                    baseUrl,
                    agentRuntime: { id: "openclaw" },
                    models: ["gpt-4.1", "gpt-4o"].map((id) => ({
                      id,
                      name: id,
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 128_000,
                      maxTokens: 1024,
                    })),
                  },
                },
              },
              plugins: { allow: ["openai"], slots: { memory: "none" } },
              skills: { load: { watch: false } },
              tools: { deny: ["*"] },
            };
          }
          await persistAuthProfileBatch({
            profiles: [
              {
                profileId: platformId,
                credential: { type: "api_key", provider: "openai", key: platformKey },
              },
              {
                profileId: otherPlatformId,
                credential: {
                  type: "api_key",
                  provider: "openai",
                  key: "synthetic-other-platform-key",
                },
              },
              {
                profileId: otherSubscriptionId,
                credential: {
                  type: "oauth",
                  provider: "openai",
                  access: "synthetic-other-subscription-token",
                  refresh: "synthetic-other-refresh",
                  expires: Date.now() + 3_600_000,
                  accountId: "synthetic-other-account",
                },
              },
              {
                profileId: subscriptionId,
                credential: {
                  type: "oauth",
                  provider: "openai",
                  access: subscriptionToken,
                  refresh: "synthetic-refresh",
                  expires: Date.now() + 3_600_000,
                  accountId: "synthetic-account",
                },
              },
            ],
          });
          const originalConfig = config("gpt-4.1");
          await state.writeConfig(originalConfig);
          setRuntimeConfigSnapshot(originalConfig);
          const binding = await captureCronInferenceBinding({
            cfg: originalConfig,
            agentId: "main",
            sessionEntry: {
              sessionId: "creator",
              updatedAt: 1,
              modelProvider: "openai",
              model: "gpt-4.1",
              authProfileOverride: profileId,
              authProfileOverrideSource: "auto",
            },
          });
          expect(binding?.profileId).toBe(profileId);
          expect(binding?.source).toBe("auto");
          const job: CronStoredJob = {
            id: "real-auth-continuity",
            name: "Real auth continuity",
            agentId: "main",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            delivery: { mode: "none" },
            payload: {
              kind: "agentTurn",
              message: "Reply with the account continuity result.",
              lightContext: true,
            },
            state: {},
            inferenceBinding: binding,
          };
          const storePath = state.statePath("cron", "jobs.json");
          await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
          await setAuthProfileOrder({
            agentDir: state.agentDir(),
            provider: "openai",
            order: [other, profileId],
          });
          await updateAuthProfileStoreWithLock({
            agentDir: state.agentDir(),
            updater(store) {
              store.lastGood = { openai: other };
              return true;
            },
          });
          const sessionIds: string[] = [];
          try {
            for (const model of ["gpt-4.1", "gpt-4o"]) {
              await resetPreparedModelRuntimeSnapshotsForTest();
              clearRuntimeAuthProfileStoreSnapshots();
              await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
              const reloaded = (await loadCronJobsStore(storePath)).jobs[0];
              expect(reloaded?.inferenceBinding).toEqual(binding);
              if (!reloaded) {
                throw new Error("Persisted automation missing");
              }
              const changed = config(model, other);
              await state.writeConfig(changed);
              setRuntimeConfigSnapshot(changed);
              const result = await runCronIsolatedAgentTurn({
                cfg: changed,
                deps: {},
                job: reloaded,
                deliveryAttemptFence: null,
                message: reloaded.payload.kind === "agentTurn" ? reloaded.payload.message : "",
                sessionKey: "cron:real-auth-continuity",
                lane: "cron",
              });
              expect(result.status, result.error).toBe("ok");
              expect(result.summary).toContain("same authorized account");
              expect(result.sessionId).toBeTruthy();
              sessionIds.push(result.sessionId!);
            }
            expect(new Set(sessionIds).size).toBe(2);
            expect(requests).toEqual(
              ["gpt-4.1", "gpt-4o"].map((model) => ({
                url: `${baseUrl}/responses`,
                model,
                authorization: `Bearer ${credential}`,
                account: profileId === subscriptionId ? "synthetic-account" : null,
              })),
            );
          } finally {
            await resetPreparedModelRuntimeSnapshotsForTest();
          }
        },
      );
    },
  );
});

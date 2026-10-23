import { zstdDecompressSync } from "node:zlib";
import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import "../llm/ai-transport-host.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent/run.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
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

const modelIds = ["gpt-4.1", "gpt-4o"];
const runtimeModels = (...ids: string[]) =>
  Object.fromEntries(
    ids.map((id) => [id, { agentRuntime: { id: "openclaw" }, params: { transport: "sse" } }]),
  );

function modelDefinition(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 1024,
  };
}

function provider(
  baseUrl: string,
  api: "openai-responses" | "openai-chatgpt-responses" = "openai-responses",
  ids = ["gpt-4.1"],
) {
  return { api, baseUrl, agentRuntime: { id: "openclaw" }, models: ids.map(modelDefinition) };
}

function configure(
  state: OpenClawTestState,
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"],
  providers: NonNullable<OpenClawConfig["models"]>["providers"],
  auth?: OpenClawConfig["auth"],
): OpenClawConfig {
  return {
    plugins: { allow: ["openai"], slots: { memory: "none" } },
    skills: { load: { watch: false } },
    tools: { deny: ["*"] },
    auth,
    agents: {
      entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
      defaults,
    },
    models: { mode: "replace", providers },
  };
}

async function writeConfig(state: OpenClawTestState, cfg: OpenClawConfig) {
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
}

function runStoredTurn(cfg: OpenClawConfig, job: CronStoredJob) {
  return runCronIsolatedAgentTurn({
    occurrence: TEST_SCHEDULED_OCCURRENCE,
    cfg,
    deps: {},
    job,
    deliveryAttemptFence: null,
    message: job.payload.kind === "agentTurn" ? job.payload.message : "",
    sessionKey: `cron:${job.id}`,
    lane: "cron",
  });
}

function interceptProvider(fetch: typeof globalThis.fetch) {
  vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
  vi.spyOn(getAiTransportHost(), "buildModelFetch").mockReturnValue(fetch);
}

function keyProfile(profileId: string, key: string) {
  return { profileId, credential: { type: "api_key" as const, provider: "openai", key } };
}

function oauthProfile(
  profileId: string,
  access: string,
  refresh = "synthetic-refresh",
  accountId = "synthetic-account",
) {
  return {
    profileId,
    credential: {
      type: "oauth" as const,
      provider: "openai",
      access,
      refresh,
      expires: Date.now() + 3_600_000,
      accountId,
    },
  };
}

function storedJob(id: string, message = "Reply."): CronStoredJob {
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
    payload: { kind: "agentTurn", message, lightContext: true },
    state: {},
  };
}

function withAuthState<T>(label: string, run: (state: OpenClawTestState) => Promise<T>) {
  return withOpenClawTestState(
    {
      label,
      env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined, OPENAI_BASE_URL: undefined },
    },
    async (state) => {
      installPrivateUpdateHandoffStore(state.root);
      return run(state);
    },
  );
}

function completedResponse(model: string): Response {
  const item = {
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "same authorized account", annotations: [] }],
  };
  const response = { id: "resp_synthetic", model, status: "in_progress", output: [] };
  const position = { item_id: item.id, output_index: 0, content_index: 0 };
  const events = [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    {
      type: "response.content_part.added",
      ...position,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      ...position,
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
      scheduledModel: false,
    },
    {
      mode: "OAuth",
      profileId: subscriptionId,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      credential: subscriptionToken,
      scheduledModel: false,
    },
    {
      mode: "scheduled-model OAuth",
      profileId: subscriptionId,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      credential: subscriptionToken,
      scheduledModel: true,
    },
  ] as const)(
    "keeps the selected $mode account across fresh runs and default changes",
    async ({ profileId, api, baseUrl, credential, scheduledModel }) => {
      await withAuthState("cron-real-auth-continuity", async (state) => {
        // Only provider HTTP is substituted; unexpected network requests fail closed.
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
        interceptProvider(providerFetch);
        const other = profileId === platformId ? otherPlatformId : otherSubscriptionId;
        function config(model: string, selected?: string): OpenClawConfig {
          const preferred = selected ?? profileId;
          return configure(
            state,
            {
              model: scheduledModel
                ? `openai/gpt-4.1@${other}`
                : `openai/${model}${selected ? `@${selected}` : ""}`,
              ...(scheduledModel ? { subagents: { model: `openai/${model}@${preferred}` } } : {}),
              models: runtimeModels("openai/gpt-4.1", "openai/gpt-4o"),
            },
            { openai: provider(baseUrl, api, modelIds) },
            {
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
          );
        }
        await persistAuthProfileBatch({
          profiles: [
            keyProfile(platformId, platformKey),
            keyProfile(otherPlatformId, "synthetic-other-platform-key"),
            oauthProfile(otherSubscriptionId, "other-token", "other-refresh", "other-account"),
            oauthProfile(subscriptionId, subscriptionToken),
          ],
        });
        const originalConfig = config("gpt-4.1");
        await writeConfig(state, originalConfig);
        const binding = await captureCronInferenceBinding({
          cfg: originalConfig,
          agentId: "main",
          sessionEntry: {
            sessionId: "creator",
            updatedAt: 1,
            modelProvider: "openai",
            model: "gpt-4.1",
            authProfileOverride: scheduledModel ? other : profileId,
            authProfileOverrideSource: "auto",
          },
        });
        expect(binding).toMatchObject({ profileId, source: scheduledModel ? "user" : "auto" });
        const job: CronStoredJob = {
          ...storedJob("real-auth-continuity", "Reply with the account continuity result."),
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
          for (const model of modelIds) {
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearRuntimeAuthProfileStoreSnapshots();
            await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
            const reloaded = (await loadCronJobsStore(storePath)).jobs[0];
            expect(reloaded?.inferenceBinding).toEqual(binding);
            if (!reloaded) {
              throw new Error("Persisted automation missing");
            }
            const changed = config(model, other);
            await writeConfig(state, changed);
            const result = await runStoredTurn(changed, reloaded);
            expect(result.status, result.error).toBe("ok");
            expect(result.summary).toContain("same authorized account");
            expect(result.sessionId).toBeTruthy();
            sessionIds.push(result.sessionId!);
          }
          expect(new Set(sessionIds).size).toBe(2);
          expect(requests).toEqual(
            modelIds.map((model) => ({
              url: `${baseUrl}/responses`,
              model,
              authorization: `Bearer ${credential}`,
              account: profileId === subscriptionId ? "synthetic-account" : null,
            })),
          );
        } finally {
          await resetPreparedModelRuntimeSnapshotsForTest();
        }
      });
    },
  );
});

it.each([
  ["configured key", undefined],
  ["unadopted stored account", "Automation has no recorded inference account"],
  ["replacement", "inference account was replaced"],
  ["revocation", "was removed or signed out"],
] as const)("enforces %s before provider HTTP through the real runner", async (kind, error) => {
  await withAuthState("cron-legacy-account", async (state) => {
    const openaiUrl = "https://api.openai.com/v1";
    const requests: Array<{ url: string; authorization: string | null }> = [];
    interceptProvider(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "POST" || !request.url.endsWith("/responses")) {
        throw new Error(`Unexpected external I/O in cron credential fixture: ${request.url}`);
      }
      requests.push({ url: request.url, authorization: request.headers.get("authorization") });
      return completedResponse("gpt-4.1");
    });
    const cfg = configure(
      state,
      {
        model: { primary: "openai/gpt-4.1", fallbacks: ["local/gpt-4.1"] },
        models: runtimeModels("openai/gpt-4.1", "local/gpt-4.1"),
      },
      {
        openai: {
          ...provider(openaiUrl),
          ...(kind === "configured key" ? { apiKey: "synthetic-config-key" } : {}),
        },
        local: provider("http://127.0.0.1:11434/v1"),
      },
      kind === "configured key"
        ? undefined
        : { profiles: { [platformId]: { provider: "openai", mode: "api_key" } } },
    );
    if (kind !== "configured key") {
      await persistAuthProfileBatch({ profiles: [keyProfile(platformId, platformKey)] });
    }
    await writeConfig(state, cfg);
    const job = storedJob("legacy-account");
    if (kind === "replacement" || kind === "revocation") {
      job.inferenceBinding = await captureCronInferenceBinding({
        cfg,
        agentId: "main",
        model: `openai/gpt-4.1@${platformId}`,
      });
      expect(job.inferenceBinding).toMatchObject({ profileId: platformId, source: "user" });
    }
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    if (kind === "replacement") {
      await persistAuthProfileBatch({
        profiles: [keyProfile(platformId, "synthetic-replacement-key")],
      });
    } else if (kind === "revocation") {
      expect(await removeAuthProfilesAcrossOwnerStores({ profileIds: [platformId] })).toBe(true);
    }
    clearRuntimeAuthProfileStoreSnapshots();
    const reloaded = (await loadCronJobsStore(storePath)).jobs[0]!;
    expect(reloaded.inferenceBinding).toEqual(job.inferenceBinding);
    try {
      const result = await runStoredTurn(cfg, reloaded);
      if (error) {
        expect(result.status).toBe("error");
        expect(result.error).toContain(error);
        expect(requests).toEqual([]);
      } else {
        expect(result.status, result.error).toBe("ok");
        expect(requests).toEqual([
          { url: `${openaiUrl}/responses`, authorization: "Bearer synthetic-config-key" },
        ]);
      }
    } finally {
      await resetPreparedModelRuntimeSnapshotsForTest();
    }
  });
});

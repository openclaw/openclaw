import fs from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "../../extensions/anthropic/cli-backend.js";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import {
  removeAuthProfilesAcrossOwnerStores,
  setAuthProfileOrder,
} from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store-runtime.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as browserOpen from "../infra/browser-open.js";
import * as runtimeBackends from "../plugins/cli-backends.runtime.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import "../agents/ai-transport-runtime-host.js"; // Initialize before spies; lazy setup copies the host.
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import * as cliPrompts from "../wizard/clack-prompter.js";
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
  const events = [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
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

it.each([false, true])(
  "keeps legacy fallback after an unapproved provider (changed primary=%s)",
  async (changedPrimary) => {
    await withAuthState("cron-legacy-fallback", async (state) => {
      const requests: string[] = [];
      interceptProvider(async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST" || request.url !== "https://api.openai.com/v1/responses") {
          throw new Error(`Unexpected I/O: ${request.url}`);
        }
        const bytes = Buffer.from(await request.arrayBuffer());
        const body = JSON.parse(
          request.headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(bytes).toString("utf8")
            : bytes.toString("utf8"),
        ) as { model: string };
        requests.push(`${request.headers.get("authorization")} ${body.model}`);
        return body.model === "gpt-4.1" && !changedPrimary
          ? new Response(
              JSON.stringify({
                error: { type: "server_error", message: "The server is overloaded" },
              }),
              { status: 503, headers: { "content-type": "application/json" } },
            )
          : completedResponse(body.model);
      });
      await persistAuthProfileBatch({ profiles: [keyProfile(platformId, platformKey)] });
      const cfg = configure(
        state,
        {
          model: changedPrimary
            ? { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-4.1"] }
            : {
                primary: "openai/gpt-4.1",
                fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-4o"],
              },
          models: runtimeModels("openai/gpt-4.1", "openai/gpt-4o", "anthropic/claude-sonnet-4-6"),
        },
        {
          openai: provider("https://api.openai.com/v1", "openai-responses", modelIds),
          anthropic: {
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            agentRuntime: { id: "openclaw" },
            models: [modelDefinition("claude-sonnet-4-6")],
          },
        },
        { profiles: { [platformId]: { provider: "openai", mode: "api_key" } } },
      );
      cfg.plugins!.allow = ["openai", "anthropic"];
      await writeConfig(state, cfg);
      const binding = await captureCronInferenceBinding({
        cfg,
        agentId: "main",
        model: `openai/gpt-4.1@${platformId}`,
      });
      expect(binding?.profileId).toBe(platformId);
      const result = await runStoredTurn(cfg, {
        ...storedJob("legacy-fallback"),
        inferenceBinding: binding ?? undefined,
      });
      expect(result.status, result.error).toBe("ok");
      const expected = changedPrimary ? ["gpt-4.1"] : ["gpt-4.1", "gpt-4o"];
      expect(requests.at(-1)).toBe(`Bearer ${platformKey} ${expected.at(-1)}`);
      expect(new Set(requests)).toEqual(
        new Set(expected.map((model) => `Bearer ${platformKey} ${model}`)),
      );
    });
  },
);

it.each([
  "approved",
  "shadowed primary runtime",
  "unapproved",
  "revoked",
  "replaced",
  "in-flight edit",
  "in-flight revocation",
  "in-flight primary revocation",
  "in-flight primary replacement",
] as const)("enforces an %s alternate account through the real cron runner", async (mode) => {
  await withAuthState("cron-approved-fallback", async (state) => {
    const requests: Array<string | null> = [];
    interceptProvider(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "POST" || !request.url.endsWith("/responses")) {
        throw new Error(`Unexpected external I/O: ${request.url}`);
      }
      const authorization = request.headers.get("authorization");
      requests.push(authorization);
      if (mode === "in-flight revocation" && authorization === `Bearer ${platformKey}`) {
        await removeAuthProfilesAcrossOwnerStores({ profileIds: [otherPlatformId] });
      }
      if (mode === "in-flight primary revocation" && authorization === `Bearer ${platformKey}`) {
        await removeAuthProfilesAcrossOwnerStores({ profileIds: [platformId] });
      }
      if (mode === "in-flight primary replacement" && authorization === `Bearer ${platformKey}`) {
        await persistAuthProfileBatch({
          profiles: [keyProfile(platformId, "synthetic-replacement-primary-key")],
        });
      }
      if (mode === "in-flight edit" && authorization === `Bearer ${platformKey}`) {
        job.inferenceGrants = {};
        cfg.agents!.defaults!.model = { primary: `openai/gpt-4.1@${platformId}`, fallbacks: [] };
      }
      return authorization === `Bearer ${platformKey}`
        ? new Response(
            JSON.stringify({ error: { code: "insufficient_quota", message: "Quota exhausted" } }),
            {
              status: 429,
              headers: { "content-type": "application/json" },
            },
          )
        : completedResponse("gpt-4o");
    });
    await persistAuthProfileBatch({
      profiles: [
        keyProfile(platformId, platformKey),
        keyProfile(otherPlatformId, "synthetic-approved-alternate-key"),
      ],
    });
    const cfg = configure(
      state,
      {
        model: {
          primary: `openai/gpt-4.1@${platformId}`,
          fallbacks: [`openai/gpt-4o@${otherPlatformId}`],
        },
        models: runtimeModels("openai/gpt-4.1", "openai/gpt-4o"),
      },
      { openai: provider("https://api.openai.com/v1", "openai-responses", modelIds) },
      {
        profiles: {
          [platformId]: { provider: "openai", mode: "api_key" },
          [otherPlatformId]: { provider: "openai", mode: "api_key" },
        },
      },
    );
    await writeConfig(state, cfg);
    const primary = await captureCronInferenceBinding({ cfg, agentId: "main" });
    const alternate = await captureCronInferenceBinding({
      cfg,
      agentId: "main",
      model: `openai/gpt-4o@${otherPlatformId}`,
    });
    expect(primary?.profileId).toBe(platformId);
    expect(alternate?.profileId).toBe(otherPlatformId);
    if (!primary || !alternate) {
      throw new Error("Expected stored accounts");
    }
    const job: CronStoredJob = {
      ...storedJob("approved-alternate"),
      inferenceBinding: primary,
      inferenceGrants: mode === "unapproved" ? {} : { "openai/gpt-4o": alternate },
    };
    if (mode === "shadowed primary runtime") {
      job.inferenceGrants!["openai/gpt-4.1"] = { ...alternate, runtime: "codex" };
    }
    if (mode === "revoked") {
      await removeAuthProfilesAcrossOwnerStores({ profileIds: [otherPlatformId] });
    } else if (mode === "replaced") {
      await persistAuthProfileBatch({
        profiles: [keyProfile(otherPlatformId, "replacement-key")],
      });
    }
    if (mode === "revoked" || mode === "replaced") {
      const result = await runStoredTurn(cfg, job);
      expect(result).toMatchObject({ status: "error", admissionDisposition: "rejected" });
      expect(result.error).toMatch(/removed|replaced|signed out/i);
      expect(requests).toEqual([]);
      return;
    }
    const result = await runStoredTurn(cfg, job);
    const succeeds =
      mode === "approved" || mode === "in-flight edit" || mode === "shadowed primary runtime";
    expect(result.status, result.error).toBe(succeeds ? "ok" : "error");
    expect(requests).toEqual(
      succeeds
        ? [`Bearer ${platformKey}`, "Bearer synthetic-approved-alternate-key"]
        : [`Bearer ${platformKey}`],
    );
  });
});

it("forwards the approved alternate account to a real noninteractive CLI after primary quota", async () => {
  await withAuthState("cron-cli-fallback", async (state) => {
    const refuseInteractiveAuth = () => {
      throw new Error("Cron attempted interactive authentication");
    };
    const browser = vi.spyOn(browserOpen, "openUrl").mockImplementation(refuseInteractiveAuth);
    const prompt = vi
      .spyOn(cliPrompts, "createClackPrompter")
      .mockImplementation(refuseInteractiveAuth);
    const effect = state.path("cli-effect.txt");
    const script = await state.writeText(
      "fixture-cli.mjs",
      `
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const credential = readFileSync(Number(process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR), "utf8");
if (credential !== "synthetic-cli-alternate") throw new Error("Wrong forwarded account");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "user") {
    writeFileSync(${JSON.stringify(effect)}, "approved CLI account");
    send({ type: "result", subtype: "success", is_error: false, result: "approved CLI account" });
  }
});
`,
    );
    // Replace only the external executable; provider preparation and FD forwarding stay real.
    const backend = buildAnthropicCliBackend();
    vi.spyOn(runtimeBackends, "resolveRuntimeCliBackends").mockReturnValue([
      {
        ...backend,
        pluginId: "anthropic",
        config: { ...backend.config, command: process.execPath, args: [script] },
      },
    ]);
    const requests: Array<string | null> = [];
    interceptProvider(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.headers.get("authorization"));
      if (request.method !== "POST" || !request.url.endsWith("/responses")) {
        throw new Error(`Unexpected I/O: ${request.url}`);
      }
      return new Response(
        JSON.stringify({ error: { code: "insufficient_quota", message: "Quota exhausted" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    });
    await persistAuthProfileBatch({
      profiles: [
        keyProfile(platformId, platformKey),
        {
          profileId: "anthropic:alternate",
          credential: { type: "api_key", provider: "anthropic", key: "synthetic-cli-alternate" },
        },
      ],
    });
    const cfg = configure(
      state,
      {
        model: {
          primary: `openai/gpt-4.1@${platformId}`,
          fallbacks: ["anthropic/claude-sonnet-4-6@anthropic:alternate"],
        },
        thinkingDefault: "off",
        models: {
          ...runtimeModels("openai/gpt-4.1"),
          "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
        },
      },
      {
        openai: provider("https://api.openai.com/v1"),
        anthropic: {
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          models: [modelDefinition("claude-sonnet-4-6")],
        },
      },
      {
        profiles: {
          [platformId]: { provider: "openai", mode: "api_key" },
          "anthropic:alternate": { provider: "anthropic", mode: "api_key" },
        },
      },
    );
    cfg.plugins!.allow = ["openai", "anthropic"];
    await writeConfig(state, cfg);
    const primary = await captureCronInferenceBinding({ cfg, agentId: "main" });
    const alternate = await captureCronInferenceBinding({
      cfg,
      agentId: "main",
      model: "anthropic/claude-sonnet-4-6@anthropic:alternate",
    });
    expect(alternate).toMatchObject({ profileId: "anthropic:alternate", runtime: "claude-cli" });
    if (!primary || !alternate) {
      throw new Error("Expected stored accounts");
    }
    const result = await runStoredTurn(cfg, {
      ...storedJob("cli-alternate"),
      inferenceBinding: primary,
      inferenceGrants: { "anthropic/claude-sonnet-4-6": alternate },
    });
    expect(result.status, result.error).toBe("ok");
    expect(await fs.readFile(effect, "utf8")).toBe("approved CLI account");
    expect(browser).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(requests).toEqual([`Bearer ${platformKey}`]);
  });
});

it.each(["API key", "OAuth", "scheduled-model OAuth"] as const)(
  "keeps the selected %s account across fresh runs and default changes",
  async (mode) => {
    const isApiKey = mode === "API key";
    const scheduledModel = mode === "scheduled-model OAuth";
    const profileId = isApiKey ? platformId : subscriptionId;
    const credential = isApiKey ? platformKey : subscriptionToken;
    const api = isApiKey ? "openai-responses" : "openai-chatgpt-responses";
    const baseUrl = isApiKey
      ? "https://api.openai.com/v1"
      : "https://chatgpt.com/backend-api/codex";
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
        ...storedJob("real-auth-continuity"),
        inferenceBinding: binding ?? undefined,
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

it.each([
  ["configured key", undefined],
  [
    "unadopted stored account",
    "Automation has no recorded inference account. Runtime openclaw would run openai/gpt-4.1 with stored account openai:platform. Record the account with openclaw automations edit <jobId> --model openai/gpt-4.1@openai:platform. For eligible host-managed accounts, openclaw doctor --fix can record it without pinning the model.",
  ],
  ["replacement", "inference account openai:platform on runtime openclaw was replaced"],
  ["revocation", "account openai:platform on runtime openclaw was removed or signed out"],
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
      job.inferenceBinding =
        (await captureCronInferenceBinding({
          cfg,
          agentId: "main",
          model: `openai/gpt-4.1@${platformId}`,
        })) ?? undefined;
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

it.each([
  { label: "refreshable control", refresh: "synthetic-refresh" },
  { label: "access-only", refresh: undefined },
])(
  "adopts then executes $label OAuth through Gateway, SQLite and HTTP 180757",
  async ({ refresh }) => {
    await withAuthState("cron-adoption-http-180757", async (state) => {
      const requests: Array<{ authorization: string | undefined; url: string | undefined }> = [];
      const http = await import("node:http");
      const responseBody = await completedResponse("gpt-4.1").text();
      const server = http.createServer((req, res) => {
        req.resume();
        requests.push({ authorization: req.headers.authorization, url: req.url });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responseBody);
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected loopback TCP server");
      }
      const cfg = configure(
        state,
        { model: "openai/gpt-4.1", models: runtimeModels("openai/gpt-4.1") },
        {
          openai: {
            ...provider(`http://127.0.0.1:${address.port}/v1`, "openai-responses"),
            apiKey: "synthetic-bootstrap-key",
          },
        },
        { profiles: { [subscriptionId]: { provider: "openai", mode: "oauth" } } },
      );
      await writeConfig(state, cfg);
      const { CronService } = await import("./service.js");
      const { createNoopLogger } = await import("./service.test-harness.js");
      const { createTestGatewayScheduler } =
        await import("../test-utils/gateway-scheduler-clock.js");
      const { createDirectChatContext } =
        await import("../gateway/server-chat.agent-events.test-helpers.js");
      const { cronHandlers } = await import("../gateway/server-methods/cron.js");
      const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
      const { closeOpenClawStateDatabaseAsync } = await import("../state/openclaw-state-db.js");
      const storePath = state.statePath("cron", "jobs.json");
      const finished: Array<{ status?: string; error?: string }> = [];
      const summaries: Array<string | undefined> = [];
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
            const result = await runCronIsolatedAgentTurn({
              ...params,
              cfg,
              deps: {},
              sessionKey: `cron:${params.job.id}`,
            });
            summaries.push(result.summary);
            return result;
          },
        });
      let cron = makeCron();
      async function invoke(method: "cron.add" | "cron.update", params: Record<string, unknown>) {
        const respond = vi.fn();
        await cronHandlers[method]!({
          req: { type: "req", id: "adoption-http-preflight", method, params },
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
      }
      try {
        await invoke("cron.add", {
          name: "access-only-adoption",
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message: "Reply with the account continuity result.",
            lightContext: true,
            toolsAllow: [],
          },
          delivery: { mode: "none" },
        });
        const [before] = (await loadCronJobsStore(storePath)).jobs;
        expect(before?.inferenceBinding).toBeUndefined();
        expect(before).toBeDefined();
        cfg.models!.providers!.openai!.api = "openai-chatgpt-responses";
        delete cfg.models!.providers!.openai!.apiKey;
        await writeConfig(state, cfg);
        await persistAuthProfileBatch({
          profiles: [
            {
              profileId: subscriptionId,
              credential: {
                type: "oauth",
                provider: "openai",
                access: subscriptionToken,
                ...(refresh === undefined ? {} : { refresh }),
                expires: Date.now() + 3_600_000,
                accountId: "synthetic-account",
                // Persisted access-only input intentionally lacks the writer type's refresh field.
              } as OAuthCredential,
            },
          ],
        });
        await invoke("cron.update", {
          id: before!.id,
          patch: {
            payload: {
              kind: "agentTurn",
              model: `openai/gpt-4.1@${subscriptionId}`,
            },
          },
        });
        cron.stop();
        await cron.waitForIdle();
        clearRuntimeAuthProfileStoreSnapshots();
        closeOpenClawAgentDatabasesForTest();
        await closeOpenClawStateDatabaseAsync();
        cron = makeCron();
        const [reloaded] = (await loadCronJobsStore(storePath)).jobs;
        expect(reloaded?.inferenceBinding).toMatchObject({
          profileId: subscriptionId,
          source: "user",
        });
        await expect(cron.run(before!.id, "force")).resolves.toEqual({ ok: true, ran: true });
        expect(finished).toHaveLength(1);
        expect(finished[0]?.status, finished[0]?.error).toBe("ok");
        expect(summaries).toEqual([expect.stringContaining("same authorized account")]);
        expect(requests).toEqual([
          { authorization: `Bearer ${subscriptionToken}`, url: "/v1/codex/responses" },
        ]);
      } finally {
        cron.stop();
        await cron.waitForIdle();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  },
);

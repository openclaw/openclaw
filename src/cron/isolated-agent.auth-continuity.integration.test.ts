import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  removeAuthProfilesAcrossOwnerStores,
  setAuthProfileOrder,
} from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store-runtime.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import * as transcriptPreparation from "../agents/embedded-agent-runner/run/attempt-transcript-lifecycle-prepare.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as browserOpen from "../infra/browser-open.js";
import type { CliBackendPlugin } from "../plugins/cli-backend.types.js";
import * as runtimeBackends from "../plugins/cli-backends.runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import * as cliPrompts from "../wizard/clack-prompter.js";
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import {
  platformId,
  subscriptionId,
  otherPlatformId,
  otherSubscriptionId,
  platformKey,
  subscriptionToken,
  modelIds,
  runtimeModels,
  modelDefinition,
  provider,
  configure,
  writeConfig,
  runStoredTurn,
  interceptProvider,
  requestedModel,
  changeAccount,
  captureAccounts,
  omitPrimary,
  keyProfile,
  oauthProfile,
  storedJob,
  withAuthState,
  quotaResponse,
  completedResponse,
  installCronAuthContinuityHooks,
} from "./isolated-agent.auth-continuity.test-support.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

installCronAuthContinuityHooks();

it.each([false, true])(
  "keeps legacy fallback after an inherited provider (changed primary=%s)",
  async (changedPrimary) => {
    await withAuthState("cron-legacy-fallback", async (state) => {
      const requests: string[] = [];
      interceptProvider(async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST" || request.url !== "https://api.openai.com/v1/responses") {
          throw new Error(`Unexpected I/O: ${request.url}`);
        }
        const model = await requestedModel(request);
        requests.push(`${request.headers.get("authorization")} ${model}`);
        return model === "gpt-4.1" && !changedPrimary
          ? Response.json(
              { error: { type: "server_error", message: "The server is overloaded" } },
              { status: 503 },
            )
          : completedResponse(model);
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

it.each(["legacy", "bound", "captured", "personal owner", "other owner", "no owner"] as const)(
  "adopts a newly configured fallback for a persisted %s job without review or resaving",
  async (kind) => {
    await withAuthState("cron-inherited-policy", async (state) => {
      const requests: string[] = [];
      interceptProvider(async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST" || request.url !== "https://api.openai.com/v1/responses") {
          throw new Error(`Unexpected I/O: ${request.url}`);
        }
        const model = await requestedModel(request);
        requests.push(`${request.headers.get("authorization")} ${model}`);
        return model === "gpt-4.1" ? quotaResponse() : completedResponse(model);
      });
      await persistAuthProfileBatch({
        profiles: [
          keyProfile(platformId, platformKey),
          keyProfile(otherPlatformId, "synthetic-configured-fallback-key"),
        ],
      });
      let fallbackProfileId = otherPlatformId;
      let ownerProfileId: string | undefined;
      if (kind.endsWith("owner")) {
        const { ensureProfileForEmail } = await import("../state/user-profiles.js");
        const { connectUserModelAccountAsync } =
          await import("../state/user-model-account-operations.js");
        const owner = ensureProfileForEmail("cron-owner@example.test");
        const personal = await connectUserModelAccountAsync({
          ownerProfileId: owner.id,
          credential: {
            type: "api_key",
            provider: "openai",
            key: "synthetic-configured-fallback-key",
          },
          assertCurrent() {},
        });
        fallbackProfileId = personal.authProfileId;
        ownerProfileId =
          kind === "personal owner"
            ? owner.id
            : kind === "other owner"
              ? ensureProfileForEmail("cron-other@example.test").id
              : undefined;
      }
      const cfg = configure(
        state,
        {
          model: { primary: `openai/gpt-4.1@${platformId}`, fallbacks: [] },
          models: runtimeModels("openai/gpt-4.1", "openai/gpt-4o"),
        },
        { openai: provider("https://api.openai.com/v1", "openai-responses", modelIds) },
        {
          profiles: {
            [platformId]: { provider: "openai", mode: "api_key" },
            [fallbackProfileId]: { provider: "openai", mode: "api_key" },
          },
        },
      );
      await writeConfig(state, cfg);
      const primary = await captureCronInferenceBinding({ cfg, agentId: "main" });
      const job = {
        ...storedJob("inherited-policy"),
        ...(ownerProfileId ? { ownerProfileId } : {}),
        ...(kind !== "legacy" ? { inferenceBinding: primary ?? undefined } : {}),
        ...(kind === "captured" ? { inferenceGrants: {} } : {}),
      };
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
      const saved = (await loadCronJobsStore(storePath)).jobs[0]!;
      cfg.agents!.defaults!.model = {
        primary: `openai/gpt-4.1@${platformId}`,
        fallbacks: [`openai/gpt-4o@${fallbackProfileId}`],
      };
      await writeConfig(state, cfg);
      const result = await runStoredTurn(cfg, saved);
      const permitted = kind !== "other owner" && kind !== "no owner";
      expect(result.status, result.error).toBe(permitted ? "ok" : "error");
      expect(requests).toEqual(
        permitted
          ? [`Bearer ${platformKey} gpt-4.1`, "Bearer synthetic-configured-fallback-key gpt-4o"]
          : [`Bearer ${platformKey} gpt-4.1`],
      );
      expect((await loadCronJobsStore(storePath)).jobs[0]).toEqual(saved);
    });
  },
);

it.each([
  "empty override",
  "model override",
  "missing",
  "ambiguous",
  "revoked",
  "new model",
] as const)("inherits model policy without bypassing %s", async (mode) => {
  await withAuthState("cron-inherited-policy-boundary", async (state) => {
    const requests: string[] = [];
    const browser = vi.spyOn(browserOpen, "openUrl").mockResolvedValue(false);
    const prompt = vi.spyOn(cliPrompts, "createClackPrompter");
    interceptProvider(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "POST" || request.url !== "https://api.openai.com/v1/responses") {
        throw new Error("Unexpected I/O: " + request.url);
      }
      const model = await requestedModel(request);
      requests.push(model);
      return model === "gpt-4.1" ? quotaResponse() : completedResponse(model);
    });
    await persistAuthProfileBatch({ profiles: [keyProfile(platformId, platformKey)] });
    const cfg = configure(
      state,
      {
        model: { primary: "openai/gpt-4.1@" + platformId, fallbacks: [] },
        models: runtimeModels("openai/gpt-4.1", "openai/gpt-4o"),
      },
      { openai: provider("https://api.openai.com/v1", "openai-responses", modelIds) },
      {
        profiles: { [platformId]: { provider: "openai", mode: "api_key" } },
      },
    );
    await writeConfig(state, cfg);
    const primary = await captureCronInferenceBinding({ cfg, agentId: "main" });
    const job: CronStoredJob = {
      ...storedJob("inherited-boundary"),
      inferenceBinding: primary ?? undefined,
      inferenceGrants: {},
      payload: {
        kind: "agentTurn",
        message: "Reply.",
        lightContext: true,
        ...(mode === "empty override" ? { fallbacks: [] } : {}),
        ...(mode === "model override" ? { model: "openai/gpt-4.1@" + platformId } : {}),
      },
    };
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    if (mode === "ambiguous") {
      await persistAuthProfileBatch({
        profiles: ["one", "two"].map((id) => ({
          profileId: "anthropic:" + id,
          credential: { type: "api_key", provider: "anthropic", key: "synthetic-ambiguous-" + id },
        })),
      });
      cfg.models!.providers!.anthropic = {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        agentRuntime: { id: "openclaw" },
        models: [modelDefinition("claude-sonnet-4-6")],
      };
      cfg.plugins!.allow = ["openai", "anthropic"];
      Object.assign(cfg.agents!.defaults!.models!, runtimeModels("anthropic/claude-sonnet-4-6"));
    }
    cfg.agents!.defaults!.model =
      mode === "new model" || mode === "model override"
        ? { primary: "openai/gpt-4o", fallbacks: [] }
        : {
            primary: "openai/gpt-4.1@" + platformId,
            fallbacks: [
              mode === "missing"
                ? "openai/gpt-4o@openai:missing"
                : mode === "ambiguous"
                  ? "anthropic/claude-sonnet-4-6"
                  : "openai/gpt-4o",
            ],
          };
    if (mode === "revoked") {
      await changeAccount(platformId, false);
    }
    await writeConfig(state, cfg);
    const reloaded = (await loadCronJobsStore(storePath)).jobs[0]!;
    const result = await runStoredTurn(cfg, reloaded);
    expect(result.status, result.error).toBe(mode === "new model" ? "ok" : "error");
    expect(requests).toEqual(
      mode === "new model" ? ["gpt-4o"] : mode === "revoked" ? [] : ["gpt-4.1"],
    );
    expect(browser).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect((await loadCronJobsStore(storePath)).jobs[0]).toEqual(reloaded);
  });
});

it("inherits a credentialless primary without manufacturing an account", async () => {
  await withAuthState("cron-native-no-auth", async (state) => {
    const requests: string[] = [];
    interceptProvider(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "POST" || request.url !== "http://127.0.0.1:11434/v1/responses") {
        throw new Error("Unexpected I/O: " + request.url);
      }
      requests.push(await requestedModel(request));
      return completedResponse("gpt-4.1");
    });
    const cfg = configure(
      state,
      { model: "local/gpt-4.1", models: runtimeModels("local/gpt-4.1") },
      {
        local: provider("http://127.0.0.1:11434/v1"),
      },
    );
    await writeConfig(state, cfg);
    const job = storedJob("native-no-auth");
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    const result = await runStoredTurn(cfg, (await loadCronJobsStore(storePath)).jobs[0]!);
    expect(result.status, result.error).toBe("ok");
    expect(requests).toEqual(["gpt-4.1"]);
    expect((await loadCronJobsStore(storePath)).jobs[0]).toEqual(job);
  });
});

const alternateModes = [
  "approved",
  "shadowed primary runtime",
  "inherited",
  "revoked",
  "replaced",
  "in-flight edit",
  "in-flight revocation",
  "in-flight primary revocation",
  "in-flight primary replacement",
  "alternate preparation primary revocation",
  "alternate preparation primary replacement",
  "changed primary approved",
  "changed primary inherited",
  "changed primary revoked",
] as const;
it.each([
  ...alternateModes.map((mode) => ({ mode, target: "isolated" as const })),
  ...(
    [
      "approved",
      "inherited",
      "alternate preparation primary revocation",
      "alternate preparation primary replacement",
      "changed primary approved",
      "changed primary replaced",
    ] as const
  ).map((mode) => ({ mode, target: "session:agent:main:approved-alternate" as const })),
])(
  "enforces an $mode alternate account through the real $target cron runner",
  async ({ mode, target }) => {
    await withAuthState("cron-approved-fallback", async (state) => {
      const requests: Array<string | null> = [];
      const models: string[] = [];
      interceptProvider(async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST" || !request.url.endsWith("/responses")) {
          throw new Error(`Unexpected external I/O: ${request.url}`);
        }
        const authorization = request.headers.get("authorization");
        models.push(await requestedModel(request));
        requests.push(authorization);
        if (mode === "in-flight revocation" && authorization === `Bearer ${platformKey}`) {
          await removeAuthProfilesAcrossOwnerStores({ profileIds: [otherPlatformId] });
        }
        if (mode.startsWith("in-flight primary") && authorization === "Bearer " + platformKey) {
          await changeAccount(platformId, mode.endsWith("replacement"));
        }
        if (mode === "in-flight edit" && authorization === `Bearer ${platformKey}`) {
          job.inferenceGrants = {};
          cfg.agents!.defaults!.model = { primary: `openai/gpt-4.1@${platformId}`, fallbacks: [] };
        }
        return authorization === `Bearer ${platformKey}`
          ? quotaResponse()
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
      const { primary, alternate } = await captureAccounts(cfg, "openai/gpt-4o@" + otherPlatformId);
      expect(primary.profileId).toBe(platformId);
      expect(alternate.profileId).toBe(otherPlatformId);
      const job: CronStoredJob = {
        ...storedJob("approved-alternate"),
        sessionTarget: target,
        inferenceBinding: primary,
        inferenceGrants: mode.endsWith("inherited") ? {} : { "openai/gpt-4o": alternate },
      };
      await omitPrimary(state, cfg, mode);
      if (mode === "shadowed primary runtime") {
        job.inferenceGrants!["openai/gpt-4.1"] = { ...alternate, runtime: "codex" };
      }
      if (mode === "revoked" || mode === "replaced") {
        await changeAccount(otherPlatformId, mode === "replaced");
        const result = await runStoredTurn(cfg, job);
        expect(result).toMatchObject({ status: "error", admissionDisposition: "rejected" });
        expect(result.error).toMatch(/removed|replaced|signed out/i);
        expect(requests).toEqual([]);
        return;
      }
      let alternatePreparation = false;
      if (mode.startsWith("alternate preparation")) {
        const prepare = transcriptPreparation.prepareEmbeddedAttemptTranscriptLifecycle;
        vi.spyOn(
          transcriptPreparation,
          "prepareEmbeddedAttemptTranscriptLifecycle",
        ).mockImplementation(async (params) => {
          const prepared = await prepare(params);
          // Primary HTTP already settled; the real alternate has entered native session preparation.
          if (requests.length === 1) {
            alternatePreparation = true;
            await changeAccount(platformId, mode.endsWith("replacement"));
          }
          return prepared;
        });
      }
      const result = await runStoredTurn(cfg, job, "claude-cli");
      if (mode.startsWith("alternate preparation")) {
        expect(alternatePreparation).toBe(true);
      }
      const succeeds = [
        "approved",
        "inherited",
        "changed primary inherited",
        "in-flight edit",
        "shadowed primary runtime",
        "changed primary approved",
      ].includes(mode);
      const initial = mode.startsWith("changed primary") ? [] : ["gpt-4.1"];
      expect(models).toEqual(succeeds ? [...initial, "gpt-4o"] : initial);
      const initialAuth = initial.map(() => "Bearer " + platformKey);
      expect(requests).toEqual(
        succeeds ? [...initialAuth, "Bearer synthetic-approved-alternate-key"] : initialAuth,
      );
      expect(result.status, result.error).toBe(succeeds ? "ok" : "error");
    });
  },
);

it.each(
  (["isolated", "session:agent:main:cli-alternate"] as const).flatMap((target) =>
    [
      "approved",
      "inherited",
      "revoked primary",
      "replaced primary",
      "changed primary approved",
      target === "isolated" ? "changed primary replaced" : "changed primary revoked",
    ].map((mode) => ({
      target,
      mode,
    })),
  ),
)(
  "enforces $mode alternate at real CLI launch for $target after primary quota",
  async ({ target, mode }) => {
    await withAuthState("cron-cli-fallback", async (state) => {
      const refuseInteractiveAuth = () => {
        throw new Error("Cron attempted interactive authentication");
      };
      const browser = vi.spyOn(browserOpen, "openUrl").mockImplementation(refuseInteractiveAuth);
      const prompt = vi
        .spyOn(cliPrompts, "createClackPrompter")
        .mockImplementation(refuseInteractiveAuth);
      const effect = state.path("cli-effect.txt");
      const launch = state.path("cli-launch.txt");
      const script = await state.writeText(
        "fixture-cli.mjs",
        `
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
writeFileSync(${JSON.stringify(launch)}, "launched");
const credential = readFileSync(Number(process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR), "utf8");
if (credential !== "synthetic-cli-alternate") throw new Error("Wrong forwarded account");
if (process.argv[process.argv.indexOf("--model") + 1] !== "claude-sonnet-4-6") throw new Error("Wrong CLI model");
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
      const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
        buildAnthropicCliBackend: () => CliBackendPlugin;
      }>({ pluginId: "anthropic", artifactBasename: "api.js" });
      const backend = buildAnthropicCliBackend();
      let alternatePreparation = false;
      vi.spyOn(runtimeBackends, "resolveRuntimeCliBackends").mockReturnValue([
        {
          ...backend,
          pluginId: "anthropic",
          config: { ...backend.config, command: process.execPath, args: [script] },
          async prepareExecution(params) {
            const prepared = await backend.prepareExecution?.(params);
            alternatePreparation = true;
            if (mode === "revoked primary" || mode === "replaced primary") {
              await changeAccount(platformId, mode === "replaced primary");
            }
            return prepared;
          },
        },
      ]);
      const requests: Array<string | null> = [];
      interceptProvider(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.headers.get("authorization"));
        if (request.method !== "POST" || !request.url.endsWith("/responses")) {
          throw new Error(`Unexpected I/O: ${request.url}`);
        }
        return quotaResponse();
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
      const { primary, alternate } = await captureAccounts(
        cfg,
        "anthropic/claude-sonnet-4-6@anthropic:alternate",
      );
      expect(alternate).toMatchObject({ profileId: "anthropic:alternate", runtime: "claude-cli" });
      await omitPrimary(state, cfg, mode);
      const result = await runStoredTurn(
        cfg,
        {
          ...storedJob("cli-alternate"),
          sessionTarget: target,
          inferenceBinding: primary,
          inferenceGrants: mode === "inherited" ? {} : { "anthropic/claude-sonnet-4-6": alternate },
        },
        "openclaw",
      );
      const succeeds =
        mode === "approved" || mode === "inherited" || mode === "changed primary approved";
      expect(await fs.readFile(launch, "utf8").catch(() => undefined)).toBe(
        succeeds ? "launched" : undefined,
      );
      expect(await fs.readFile(effect, "utf8").catch(() => undefined)).toBe(
        succeeds ? "approved CLI account" : undefined,
      );
      expect(browser).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(requests).toEqual(mode.startsWith("changed primary") ? [] : [`Bearer ${platformKey}`]);
      expect(alternatePreparation).toBe(!mode.startsWith("changed primary") || succeeds);
      expect(result.status, result.error).toBe(succeeds ? "ok" : "error");
    });
  },
);

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
        const model = await requestedModel(request);
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          account: request.headers.get("chatgpt-account-id"),
          model,
        });
        return completedResponse(model);
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
    });
  },
);

it.each([
  ["configured key", undefined],
  ["legacy stored account", undefined],
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
      await changeAccount(platformId, true);
    } else if (kind === "revocation") {
      expect(await removeAuthProfilesAcrossOwnerStores({ profileIds: [platformId] })).toBe(true);
    }
    clearRuntimeAuthProfileStoreSnapshots();
    const reloaded = (await loadCronJobsStore(storePath)).jobs[0]!;
    expect(reloaded.inferenceBinding).toEqual(job.inferenceBinding);
    const result = await runStoredTurn(cfg, reloaded);
    if (error) {
      expect(result.status).toBe("error");
      expect(result.error).toContain(error);
      expect(requests).toEqual([]);
    } else {
      expect(result.status, result.error).toBe("ok");
      expect(requests).toEqual([
        {
          url: `${openaiUrl}/responses`,
          authorization:
            kind === "configured key" ? "Bearer synthetic-config-key" : "Bearer " + platformKey,
        },
      ]);
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

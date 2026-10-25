import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { expect, it, vi } from "vitest";
import { resolveAgentModelFallbacksOverride } from "../agents/agent-scope.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import * as authProfileStore from "../agents/auth-profiles/store-runtime.js";
import { loadCronJobsStore, resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import { connectUserModelAccount } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  cronJob,
  currentModel,
  noSuccessor,
  readSession,
  repairConfig,
  retiredModel,
  writeSession,
} from "./doctor-model-repair.test-support.js";
import { createRetiredModelFixture } from "./doctor-retired-models.test-support.js";
import { repairCronCodexModelRefsAfterConfigWrite } from "./doctor/cron/legacy-repair.js";
import { maybeRepairCodexSessionRoutes } from "./doctor/shared/codex-route-session-repair.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./doctor/shared/legacy-config-migrations.runtime.models.codex.js";

async function fixture(...args: Parameters<typeof createRetiredModelFixture>) {
  const { cfg, state } = await createRetiredModelFixture(...args);
  return {
    cfg,
    state,
    defaults: cfg.agents!.defaults!,
    main: cfg.agents!.entries!.main!,
    sessions: (shouldRepair = true, blockedModelIdentities?: ReadonlySet<string>) =>
      maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair, blockedModelIdentities }),
    repair: (config = cfg, providers = ["openai"]) => repairConfig(config, state.env, providers),
  };
}

async function writePlatformProfile(state: Awaited<ReturnType<typeof fixture>>["state"]) {
  await state.writeAuthProfiles(
    {
      version: 1,
      profiles: { chatgpt: { provider: "openai", type: "api_key", key: "synthetic-other-key" } },
    },
    "platformagent",
  );
}

it("repairs only the retired physical route in OAuth config", async () => {
  const { cfg, defaults, main, repair } = await fixture("oauth");
  defaults.model = { primary: retiredModel, fallbacks: [noSuccessor, currentModel] };
  main.model = noSuccessor;
  main.modelPolicy = { allow: [noSuccessor] };
  defaults.modelPolicy = { allow: [retiredModel] };
  defaults.models = { [retiredModel]: { alias: "retired-alias" } };
  const retiredRef = retiredModel;
  defaults.subagents = { model: "openai/retired-with-slash" };
  defaults.heartbeat = { model: "openai/gpt-5.4-codex" };
  defaults.imageModel = { primary: retiredRef, timeoutMs: 50 };
  defaults.pdfModel = { primary: noSuccessor, timeoutMs: 50 };
  defaults.voiceModel = retiredRef;
  defaults.mediaModels = { image: retiredRef, video: retiredRef, music: retiredRef };
  defaults.compaction = { model: retiredRef };
  main.tools = { exec: { reviewer: { model: retiredRef } } };
  main.tts = { summaryModel: retiredRef };
  cfg.tools = { exec: { reviewer: { model: retiredRef } } };
  const mediaPreference = { preferredModel: retiredRef };
  cfg.tools.media = { image: mediaPreference, audio: mediaPreference, video: mediaPreference };
  cfg.tts = { summaryModel: retiredRef };
  cfg.hooks = { gmail: { model: retiredRef }, mappings: [{ model: retiredRef }] };
  cfg.channels = {
    modelByChannel: { telegram: { synthetic: retiredRef } },
    discord: {
      voice: { model: retiredRef, tts: { summaryModel: retiredRef } },
      accounts: {
        synthetic: { voice: { model: retiredRef, tts: { summaryModel: retiredRef } } },
      },
    },
  };
  const result = repair(cfg);
  expect(result.config.agents?.defaults).toMatchObject({
    model: { primary: currentModel, fallbacks: [currentModel] },
    modelPolicy: { allow: [retiredModel, currentModel] },
    subagents: { model: "openai/family/current-model" },
    heartbeat: { model: currentModel },
    voiceModel: defaults.voiceModel,
    mediaModels: defaults.mediaModels,
  });
  expect(result.config.agents?.entries?.main?.model).toBeUndefined();
  expect(result.config.agents?.entries?.main?.modelPolicy?.allow).toEqual([
    noSuccessor,
    currentModel,
  ]);
  expect(result.config.agents?.defaults?.models).toEqual({
    [retiredModel]: { alias: "retired-alias" },
    [currentModel]: {},
  });
  expect(result.config.agents?.defaults?.pdfModel).toEqual({ timeoutMs: 50 });
  expect(result.config.tools?.media).toEqual(cfg.tools?.media);
  expect(
    collectConfiguredModelRefs(result.config).filter(
      ({ path: configPath, value }) =>
        value.includes("retired-with") &&
        !configPath.includes(".models.") &&
        !configPath.includes(".mediaModels.") &&
        !configPath.includes(".voiceModel") &&
        !configPath.startsWith("tools.media."),
    ),
  ).toEqual([]);
  expect(result.changes.join("\n")).toContain("inherit");
});

it("diagnoses a global default without a successor instead of selecting another provider", async () => {
  const { cfg, defaults, main, repair } = await fixture();
  defaults.model = noSuccessor;
  const result = repair(cfg);
  expect(result.config.agents?.defaults?.model).toBe(noSuccessor);
  expect(result.warnings.join("\n")).toContain("no provider successor");
  defaults.model = currentModel;
  main.model = "openai/retired-global-without-successor";
  const load = vi
    .spyOn(authProfileStore, "loadAuthProfileStoreForSecretsRuntime")
    .mockImplementation(() => {
      throw new Error("Credential storage unavailable");
    });
  const globalRetirement = repair(cfg);
  expect(globalRetirement.config.agents?.entries?.main?.model).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
});

it("keeps a shared default and local successor routing policy", async () => {
  const { cfg, state, defaults, main, repair } = await fixture();
  defaults.model = retiredModel;
  defaults.modelPolicy = { allow: [retiredModel] };
  defaults.models = {
    [retiredModel]: {
      alias: "daily",
      agentRuntime: { id: "codex" },
      params: { temperature: 0.25, maxTokens: 128 },
    },
    [currentModel]: { alias: "current-alias", agentRuntime: { id: "codex" } },
  };
  main.model = retiredModel;
  main.models = {
    [retiredModel]: { alias: "local-old", agentRuntime: { id: "openclaw" } },
    [currentModel]: {
      alias: "local-current",
      agentRuntime: { id: "codex" },
      params: { temperature: 0.5 },
    },
  };
  cfg.agents!.entries!.platformagent = {};
  await writePlatformProfile(state);
  const result = repair(cfg);
  expect(result.config.agents?.defaults?.model).toBe(retiredModel);
  expect(result.config.agents?.entries?.main?.model).toBe(currentModel);
  expect(result.config.agents?.entries?.main?.modelPolicy?.allow).toEqual([
    retiredModel,
    currentModel,
  ]);
  expect(result.config.agents?.entries?.main?.models?.[currentModel]).toEqual({
    alias: "local-current",
    agentRuntime: { id: "codex" },
    params: { temperature: 0.5, maxTokens: 128 },
  });
  expect(result.config.agents?.entries?.platformagent).toEqual({});
  expect(result.config.agents?.defaults?.models).toEqual(cfg.agents?.defaults?.models);
  expect(repair(result.config).changes).toEqual([]);
  delete main.model;
  defaults.model = { primary: retiredModel, fallbacks: ["openai/fallback-model"] };
  const inherited = repair(cfg);
  expect(inherited.config.agents?.entries?.main?.model).toEqual({
    primary: currentModel,
    fallbacks: ["openai/fallback-model"],
  });
  expect(inherited.config.agents?.defaults?.model).toEqual(cfg.agents?.defaults?.model);
  expect(result.warnings.join("\n")).toContain("different repairs");
});

it("repairs inherited fallbacks without pinning a healthy shared primary", async () => {
  const { cfg, state, defaults, repair } = await fixture();
  defaults.model = { primary: currentModel, fallbacks: [retiredModel] };
  cfg.agents!.entries = {
    main: {},
    platformagent: {},
    explicitstring: { model: "openai/explicit-model" },
    explicitobject: { model: { primary: "openai/explicit-model" } },
    ownfallback: { model: { fallbacks: ["openai/own-fallback"] } },
  };
  await writePlatformProfile(state);
  const result = repair(cfg);
  expect(result.config.agents?.defaults?.model).toEqual(cfg.agents?.defaults?.model);
  expect(result.config.agents?.entries?.main?.model).toEqual({ fallbacks: [currentModel] });
  expect(resolveAgentModelFallbacksOverride(result.config, "main")).toEqual([currentModel]);
  for (const agentId of ["platformagent", "explicitstring", "explicitobject", "ownfallback"]) {
    expect(result.config.agents?.entries?.[agentId]).toEqual(cfg.agents?.entries?.[agentId]);
  }
});

it("repairs persisted cron primary and fallbacks in the existing post-config-write pass", async () => {
  const { cfg } = await fixture();
  const storePath = resolveCronJobsStorePath();
  const job = cronJob("retired-cron", noSuccessor, [retiredModel, currentModel], {
    enabled: false,
    state: { autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 10 } },
  });
  await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
  await repairCronCodexModelRefsAfterConfigWrite({ migrateCodexModelRefs: true, cfg });
  expect((await loadCronJobsStore(storePath)).jobs[0]?.payload).toEqual(job.payload);
  const result = await repairCronCodexModelRefsAfterConfigWrite({
    migrateCodexModelRefs: true,
    cfg,
    repairRetiredModelRefs: true,
  });
  const saved = (await loadCronJobsStore(storePath)).jobs[0]!;
  expect(saved.payload).toEqual({
    kind: "agentTurn",
    message: "Synthetic reminder",
    fallbacks: [currentModel, currentModel],
  });
  expect(result.changes.join("\n")).toContain("inherit");
  expect(saved.enabled).toBe(false);
  expect(result.changes.join("\n")).toContain("openclaw automations enable retired-cron");
});

it.each([
  { blocked: false, retiredId: "retired-with-successor" },
  { blocked: false, retiredId: "retired-without-successor" },
  { blocked: true, retiredId: "retired-without-successor" },
])(
  "composes namespace retirement ($retiredId, blocked=$blocked)",
  async ({ blocked, retiredId }) => {
    const { cfg, state, defaults, main, repair, sessions } = await fixture();
    main.models = { [currentModel]: { agentRuntime: { id: "codex" } } };
    const legacyRef = `openai-codex/${retiredId}`;
    if (blocked) {
      const model = {
        id: retiredId,
        name: "Synthetic",
        reasoning: false,
        input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      };
      cfg.models!.providers!.openai = {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        models: [{ ...model, input: [...model.input] }],
      };
      cfg.models!.providers!["openai-codex"] = {
        baseUrl: "https://proxy.example.test/v1",
        api: "openai-responses",
        models: [{ ...model, input: [...model.input] }],
      };
      defaults.models = { [legacyRef]: { alias: "legacy-proxy" } };
      defaults.model = "legacy-proxy";
    }
    const blockedModelIdentities = new Set(
      collectBlockedLegacyOpenAICodexProviderPlan(cfg).blockedModelIdentities,
    );
    expect(blockedModelIdentities.size > 0).toBe(blocked);
    const storePath = resolveCronJobsStorePath();
    const job = cronJob("legacy-retired", legacyRef, undefined, {
      name: "Legacy synthetic reminder",
      schedule: { kind: "every", everyMs: 60000, anchorMs: 1 },
    });
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    const result = await repairCronCodexModelRefsAfterConfigWrite({
      migrateCodexModelRefs: true,
      cfg,
      blockedModelIdentities,
      repairRetiredModelRefs: true,
    });
    const payload = (await loadCronJobsStore(storePath)).jobs[0]?.payload;
    expect(payload?.kind === "agentTurn" ? payload.model : undefined).toBe(
      blocked ? legacyRef : retiredId === "retired-without-successor" ? undefined : currentModel,
    );
    if (!blocked) {
      expect(result.warnings).toEqual([]);
    } else {
      const repaired = repair(cfg, ["openai", "openai-codex"]);
      expect(repaired.config.agents?.defaults?.model).toBe("legacy-proxy");
      expect(repaired.config.agents?.defaults?.models).toEqual(cfg.agents?.defaults?.models);
      const sessionKey = "agent:main:blocked-legacy";
      await writeSession(state, sessionKey, {
        providerOverride: "openai-codex",
        modelOverride: retiredId,
        authProfileOverride: "chatgpt",
        authProfileOverrideSource: "user",
      });
      await sessions(true, blockedModelIdentities);
      expect(readSession(state, sessionKey)).toMatchObject({
        providerOverride: "openai-codex",
        modelOverride: retiredId,
        authProfileOverride: "chatgpt",
      });
    }
  },
);

it("clears session pin ownership when inheriting another provider", async () => {
  const { state, defaults, sessions } = await fixture();
  defaults.model = "anthropic/current-model";
  const retiredRef = noSuccessor;
  defaults.models = { [retiredRef]: { alias: "retired-alias" } };
  defaults.modelPolicy = { allow: [retiredRef, "anthropic/current-model"] };
  const sessionKey = "agent:main:retired-alias";
  await writeSession(state, sessionKey, {
    modelOverride: "retired-alias",
    modelOverrideSource: "user",
    authProfileOverride: "chatgpt",
    authProfileOverrideSource: "user",
  });
  const result = await sessions();
  expect(result.changes[0]).toContain("in 1 session across ");
  const entry = readSession(state, sessionKey);
  expect(entry?.modelOverride).toBeUndefined();
  expect(entry?.providerOverride).toBeUndefined();
  expect(entry?.authProfileOverride).toBeUndefined();
  expect(entry?.authProfileOverrideSource).toBeUndefined();
});

it("preserves a retired session pin when its successor is only the configured default", async () => {
  const { state, defaults, sessions } = await fixture();
  defaults.modelPolicy = { allow: [retiredModel] };
  const sessionKey = "agent:main:restricted-successor";
  const entry = {
    sessionId: "restricted-successor",
    updatedAt: 1,
    providerOverride: "openai",
    modelOverride: "retired-with-successor",
    modelOverrideSource: "user" as const,
    authProfileOverride: "chatgpt",
    authProfileOverrideSource: "user" as const,
  };
  await writeSession(state, sessionKey, entry);
  for (const shouldRepair of [false, true, true]) {
    const result = await sessions(shouldRepair);
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain(`"${currentModel}" is not permitted`);
    expect(readSession(state, sessionKey)).toMatchObject(entry);
  }
});

it("repairs session choices and model-derived state while preserving Platform pins", async () => {
  const { cfg, state, defaults, sessions } = await fixture();
  cfg.auth!.order!.openai = ["platform"];
  defaults.model = "current-alias";
  defaults.models = { [currentModel]: { alias: "current-alias" } };
  const owner = ensureProfileForEmail("reader@example.test");
  const personal = connectUserModelAccount({
    ownerProfileId: owner.id,
    credential: {
      provider: "openai",
      type: "oauth",
      access: "synthetic-personal-access",
      refresh: "synthetic-personal-refresh",
      expires: 9_999_999_999_999,
    },
    assertCurrent: () => {},
  }).authProfileId;
  for (const [suffix, profile, source] of [
    ["chatgpt", "chatgpt", "user"],
    ["platform", "platform", "user"],
    ["personal", personal, "user-link"],
    ["clear-personal", personal, "user-link"],
    ["auto", "chatgpt", "auto"],
  ] as const) {
    await writeSession(state, `agent:main:${suffix}`, {
      modelOverride:
        suffix === "clear-personal" ? "retired-without-successor" : "retired-with-successor",
      providerOverride: "openai",
      modelOverrideSource: "user",
      authProfileOverride: profile,
      authProfileOverrideSource: source,
      contextTokens: 123,
      model: "retired-with-successor",
      modelProvider: "openai",
    });
  }
  const preview = await sessions(false);
  expect(preview.warnings.join("\n")).toContain("doctor --fix");
  expect(readSession(state, "agent:main:chatgpt")?.modelOverride).toBe("retired-with-successor");
  const result = await sessions();
  expect(result.changes[0]).toContain("in 3 sessions across ");
  const repaired = readSession(state, "agent:main:chatgpt");
  expect(repaired).toMatchObject({
    modelOverride: "current-model",
    authProfileOverride: "chatgpt",
  });
  expect(repaired?.contextTokens).toBeUndefined();
  expect(readSession(state, "agent:main:personal")).toMatchObject({
    modelOverride: "current-model",
    authProfileOverride: personal,
    authProfileOverrideSource: "user-link",
  });
  expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles[personal]).toBeUndefined();
  const cleared = readSession(state, "agent:main:clear-personal");
  expect(cleared?.modelOverride).toBeUndefined();
  expect(cleared).toMatchObject({
    authProfileOverride: personal,
    authProfileOverrideSource: "user-link",
  });
  expect(readSession(state, "agent:main:auto")?.modelOverride).toBe("retired-with-successor");
  expect(readSession(state, "agent:main:platform")?.modelOverride).toBe("retired-with-successor");
  cfg.models!.providers!.openai!.baseUrl = "https://chatgpt.com/backend-api/codex";
  await writeSession(state, "agent:main:missing-pin", {
    modelOverride: "retired-with-successor",
    providerOverride: "openai",
    authProfileOverride: "missing-account",
    authProfileOverrideSource: "user",
  });
  await sessions();
  expect(readSession(state, "agent:main:missing-pin")?.modelOverride).toBe(
    "retired-with-successor",
  );
});

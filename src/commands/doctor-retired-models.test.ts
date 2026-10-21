import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { expect, it, vi } from "vitest";
import { resolveAgentModelFallbacksOverride } from "../agents/agent-scope.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import * as authProfileStore from "../agents/auth-profiles/store-runtime.js";
import type { ModelAuthAvailabilityEvaluation } from "../agents/model-auth-availability.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronJobsStore, resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { runCodexSessionRouteHealth } from "../flows/doctor-health-contribution-runners.state.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import { connectUserModelAccount } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  cronJob,
  currentModel,
  noSuccessor,
  readSession,
  repairConfig,
  repairPersistedRoutes,
  seedCronModel,
  retiredModel,
  writeSession,
} from "./doctor-model-repair.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  createNativeXaiRetirementFixture as nativeFixture,
  createRetiredModelFixture,
} from "./doctor-retired-models.test-support.js";
import { repairCronCodexModelRefsAfterConfigWrite } from "./doctor/cron/legacy-repair.js";
import { maybeRepairCodexSessionRoutes } from "./doctor/shared/codex-route-session-repair.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./doctor/shared/legacy-config-migrations.runtime.models.codex.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredConfigModelRefs,
} from "./doctor/shared/retired-model-ref-repair.js";
import { repairRetiredSessionModelRef } from "./doctor/shared/retired-session-model-repair.js";

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
  defaults.model = { primary: "retired-alias", fallbacks: [noSuccessor, currentModel] };
  main.model = noSuccessor;
  main.modelPolicy = { allow: [noSuccessor] };
  defaults.modelPolicy = { allow: [retiredModel] };
  defaults.models = {
    [retiredModel]: { alias: "retired-alias", params: { temperature: 0.25 } },
  };
  const retiredRef = retiredModel;
  defaults.subagents = { model: "openai/retired-with-slash" };
  defaults.heartbeat = { model: "openai/gpt-5.4-codex" };
  defaults.imageModel = { primary: retiredRef, timeoutMs: 50 };
  defaults.pdfModel = { primary: noSuccessor, timeoutMs: 50 };
  defaults.voiceModel = retiredRef;
  defaults.mediaModels = { image: retiredRef, video: retiredRef, music: retiredRef };
  defaults.compaction = { memoryFlush: { model: retiredRef } };
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
    [retiredModel]: { alias: "retired-alias", params: { temperature: 0.25 } },
    [currentModel]: { params: { temperature: 0.25 } },
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
  expect(result.warnings.join("\n")).toContain("do not share a verified successor");
  const repeated = repair(result.config);
  expect([repeated.config, repeated.changes]).toEqual([result.config, []]);
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
        ...authoredModel(retiredId),
        name: "Synthetic",
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
  expect(result.repairedSessions).toBe(1);
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
    expect(result.repairedSessions).toBe(0);
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
  expect(result.repairedSessions).toBe(3);
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

function expectRouteWarning(warnings: string[], model: string, detail: string) {
  const parts = [model, 'agent "main"', detail, "allowed model override", "doctor --fix"];
  for (const expected of parts) {
    expect.soft(warnings.join("\n")).toContain(expected);
  }
}

function authoredModel(id: string, baseUrl?: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 4_096,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

it("retains a pinned session when clearing would keep the exact retired model account", async () => {
  const { cfg, state } = await fixture("api-key");
  const retiredRef = noSuccessor;
  cfg.agents!.defaults!.model = retiredRef;
  cfg.agents!.defaults!.models = { [retiredRef]: { alias: "retired-alias" } };
  const selections = [
    { source: "user", model: "retired-without-successor", provider: "openai" },
    { source: "user-link", model: "retired-alias", provider: undefined },
  ] as const;
  for (const selection of selections) {
    await writeSession(state, `agent:main:no-op-${selection.source}`, {
      providerOverride: selection.provider,
      modelOverride: selection.model,
      authProfileOverride: "chatgpt",
      authProfileOverrideSource: selection.source,
    });
  }
  const cronStore = await seedCronModel("clear-cron-pin", `${retiredRef}@chatgpt`);
  const configRepair = repairConfig(cfg, state.env);
  expect(configRepair.changes).toEqual([]);
  const { sessions: result, cron: cronRepair } = await repairPersistedRoutes(
    configRepair.config,
    state,
  );
  expect.soft(result.repairedSessions).toBe(0);
  for (const selection of selections) {
    const entry = readSession(state, `agent:main:no-op-${selection.source}`);
    expect.soft(entry).toMatchObject({
      modelOverride: selection.model,
      authProfileOverride: "chatgpt",
      authProfileOverrideSource: selection.source,
    });
    expect.soft(entry?.providerOverride).toBe(selection.provider);
  }
  expect.soft(result.warnings).toHaveLength(1);
  expectRouteWarning(result.warnings, retiredRef, "supported default");
  const payload = (await loadCronJobsStore(cronStore)).jobs[0]?.payload;
  expect(payload?.kind === "agentTurn" ? payload.model : undefined).toBeUndefined();
  expect(cronRepair.warnings).toEqual([]);
});

it.each(["blocked", "unrestricted", "already allowed"])(
  "checks pinned subscription successors against %s owner policy",
  async (policy) => {
    const { cfg, state } = await fixture("api-key");
    const retiredRef = retiredModel;
    const successor = currentModel;
    cfg.agents!.defaults!.model = retiredRef;
    if (policy !== "unrestricted") {
      cfg.agents!.entries!.main!.modelPolicy = {
        allow: policy === "blocked" ? [retiredRef] : [retiredRef, successor],
      };
    }
    for (const source of ["user", "user-link"] as const) {
      await writeSession(state, `agent:main:pinned-${source}`, {
        providerOverride: "openai",
        modelOverride: "retired-with-successor",
        authProfileOverride: "chatgpt",
        authProfileOverrideSource: source,
      });
    }
    const cronStore = await seedCronModel("pinned-policy", `${retiredRef}@chatgpt`);
    const repair = repairConfig(cfg, state.env);
    expect(repair.config).toEqual(cfg);
    const { sessions: sessionRepair, cron: cronRepair } = await repairPersistedRoutes(
      repair.config,
      state,
    );
    for (const source of ["user", "user-link"] as const) {
      expect.soft(readSession(state, `agent:main:pinned-${source}`)).toMatchObject({
        providerOverride: "openai",
        modelOverride: policy === "blocked" ? "retired-with-successor" : "current-model",
        authProfileOverride: "chatgpt",
        authProfileOverrideSource: source,
      });
    }
    const payload = (await loadCronJobsStore(cronStore)).jobs[0]?.payload;
    expect
      .soft(payload?.kind === "agentTurn" ? payload.model : undefined)
      .toBe(`${policy === "blocked" ? retiredRef : successor}@chatgpt`);
    for (const result of [sessionRepair, cronRepair]) {
      if (policy === "blocked") {
        expectRouteWarning(result.warnings, successor, "agents.entries.main.modelPolicy.allow");
      } else {
        expect(result.warnings).toEqual([]);
      }
    }
    expect(repair.config).toEqual(cfg);
  },
);

it.each([
  { scenario: "shared alias", profile: "chatgpt" },
  { scenario: "changed default provider", profile: "chatgpt" },
  { scenario: "shared alias", profile: "platform" },
  { scenario: "changed default provider", profile: "platform" },
  { scenario: "provider-wide alias", profile: "chatgpt" },
  { scenario: "successor alias policy", profile: "platform" },
])("preserves $profile refs after config changes $scenario", async ({ scenario, profile }) => {
  const { cfg, state } = await fixture();
  const providerWide = scenario === "provider-wide alias";
  const sharedAlias = scenario === "shared alias" || scenario === "successor alias policy";
  const retiredRef = providerWide
    ? "openai/retired-global-without-successor"
    : scenario === "successor alias policy"
      ? retiredModel
      : noSuccessor;
  const rawRef = scenario === "changed default provider" ? "retired-without-successor" : "daily";
  const settings = {
    alias: "daily",
    agentRuntime: { id: "openclaw" },
    params: { temperature: 0.25, maxTokens: 128 },
  };
  cfg.agents!.entries!.main!.models = { [retiredRef]: settings };
  const policyRef = scenario === "successor alias policy" ? "daily" : retiredRef;
  cfg.agents!.entries!.main!.modelPolicy = { allow: [policyRef] };
  if (scenario === "changed default provider") {
    cfg.agents!.defaults!.model = "anthropic/current-model";
    cfg.agents!.entries!.main!.model = retiredRef;
  }
  const sessionKey = "agent:main:retired-ordering";
  await writeSession(state, sessionKey, {
    modelOverride: rawRef,
    authProfileOverride: profile,
    authProfileOverrideSource: "user",
  });
  const cronStorePath = await seedCronModel(
    "retired-ordering",
    profile === "platform" ? `${rawRef}@platform` : rawRef,
  );
  const repair = repairConfig(cfg, state.env, ["openai", "anthropic"]);
  const updatedMain = repair.config.agents?.entries?.main;
  expect.soft(updatedMain?.models?.[retiredRef]).toEqual(providerWide ? undefined : settings);
  const defaultRef =
    scenario === "changed default provider" ? "anthropic/current-model" : currentModel;
  expect
    .soft(updatedMain?.modelPolicy?.allow)
    .toEqual(providerWide ? [defaultRef] : [policyRef, defaultRef]);
  if (scenario === "successor alias policy") {
    const { alias: _alias, ...successorSettings } = settings;
    expect.soft(updatedMain?.models?.[defaultRef]).toEqual(successorSettings);
  }
  const allowed = buildAllowedModelSet({
    cfg: repair.config,
    agentId: "main",
    catalog: [],
    defaultProvider: scenario === "changed default provider" ? "anthropic" : "openai",
    defaultModel: "current-model",
  });
  expect.soft(allowed.allowAny).toBe(false);
  expect.soft(allowed.allowedKeys.has(retiredRef)).toBe(!providerWide);
  expect.soft(allowed.allowedKeys.has(defaultRef)).toBe(true);
  expect(updatedMain?.model).toBeUndefined();
  await state.writeConfig(repair.config);
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const options = { repair: true, nonInteractive: true };
  const ctx: DoctorHealthFlowContext = {
    cfg: repair.config,
    cfgForPersistence: structuredClone(repair.config),
    configResult: { ...repair, cfg: repair.config },
    configPath: state.configPath,
    sourceConfigValid: true,
    env: state.env,
    runtime,
    options,
    prompter: createDoctorPrompter({ runtime, options }),
  };
  await runCodexSessionRouteHealth(ctx);
  await runWriteConfigHealth(ctx);
  const savedSession = readSession(state, sessionKey);
  expect
    .soft(savedSession?.modelOverride)
    .toBe(
      profile === "platform" ? (sharedAlias ? "daily" : "retired-without-successor") : undefined,
    );
  if (profile === "platform") {
    expect
      .soft(savedSession)
      .toMatchObject({ authProfileOverride: "platform", authProfileOverrideSource: "user" });
    expect.soft(savedSession?.providerOverride).toBe(sharedAlias ? undefined : "openai");
    const interpretation = { cfg: repair.config, agentId: "main", defaultProvider: "openai" };
    expect(
      resolveModelRefFromString({
        ...interpretation,
        raw: savedSession!.modelOverride!,
        aliasIndex: buildModelAliasIndex(interpretation),
      })?.ref,
    ).toEqual({ provider: "openai", model: retiredRef.slice("openai/".length) });
  }
  const payload = (await loadCronJobsStore(cronStorePath)).jobs[0]?.payload;
  expect(payload?.kind === "agentTurn" ? payload.model : undefined).toBe(
    profile === "platform" ? `${sharedAlias ? rawRef : retiredRef}@platform` : undefined,
  );
  expect(repairConfig(repair.config, state.env, ["openai", "anthropic"]).changes).toEqual([]);
});
it.each(["native", "model override", "private ID"] as const)(
  "preserves the logical account while checking authored %s model retirement",
  async (scenario) => {
    const { cfg, state, repair } = await nativeFixture();
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "personal:fixture": {
          provider: "personal",
          type: "api_key",
          key: "synthetic-personal-key",
        },
      },
    });
    const id = scenario === "private ID" ? "private-model" : "auto";
    const ref = `personal/${id}`;
    const configuredModel = authoredModel(
      id,
      scenario === "model override" ? "https://custom.invalid/v1" : undefined,
    );
    cfg.auth = { order: { personal: ["personal:fixture"] } };
    cfg.agents!.defaults = {
      workspace: state.workspaceDir,
      model: { primary: `${ref}@personal:fixture` },
      subagents: { model: `${ref}@personal:fixture` },
      models: { [ref]: { alias: "Personal", params: { temperature: 0.25 } } },
      modelPolicy: { allow: [ref] },
    };
    cfg.models = {
      providers: {
        personal: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
          auth: "api-key",
          models: [configuredModel],
        },
      },
    };
    const result = repair(cfg);
    const updated = result.config.agents?.defaults;
    const expected = scenario === "native" ? "personal/grok-4.7" : ref;
    expect(updated?.model).toEqual({
      primary: `${expected}@personal:fixture`,
    });
    expect(updated?.subagents?.model).toBe(`${expected}@personal:fixture`);
    expect(updated?.models).toEqual({
      [expected]: { alias: "Personal", params: { temperature: 0.25 } },
    });
    expect(updated?.modelPolicy?.allow).toEqual([expected]);
    expect([result.config.auth, result.config.models]).toEqual([cfg.auth, cfg.models]);
    expect(result.warnings).toEqual([]);
    const repeated = repair(result.config);
    expect([repeated.config, repeated.changes]).toEqual([result.config, []]);
    expect(repeated.warnings).toEqual([]);
  },
);

it.each(["environment", "configured", "implicit-account", "pinned-fallback"] as const)(
  "repairs native xAI selections while preserving policy and unresolved pins (%s)",
  async (scenario) => {
    const { cfg, state } = await nativeFixture();
    if (scenario === "environment" || scenario === "implicit-account") {
      await state.writeAuthProfiles({ version: 1, profiles: {} });
      delete cfg.auth!.order;
    }
    if (scenario === "environment") {
      delete cfg.models;
      delete cfg.auth;
      cfg.agents!.defaults!.subagents = { model: "XAI/auto" };
    }
    if (scenario === "pinned-fallback") {
      cfg.agents!.defaults!.model = {
        primary: "Grok",
        fallbacks: ["xai/auto@xai:missing", "xai/grok-4.3"],
      };
      cfg.agents!.defaults!.heartbeat = { model: "xai/grok-4.3", every: "30m" };
      cfg.agents!.entries!.main = { model: "xai/auto@xai:missing" };
    }
    const env =
      scenario === "environment"
        ? { ...state.env, XAI_API_KEY: "synthetic-env-xai-key" }
        : state.env;
    const repair = (config: OpenClawConfig) => repairConfig(config, env, ["xai"]);

    const result = repair(cfg);
    const updated = result.config.agents?.defaults;
    expect(
      resolveDefaultModelForAgent({
        cfg: result.config,
        ...(scenario === "pinned-fallback" ? {} : { agentId: "main" }),
      }),
    ).toEqual({ provider: "xai", model: "grok-4.7" });
    expect(updated?.model).toMatchObject({
      fallbacks:
        scenario === "pinned-fallback"
          ? ["xai/auto@xai:missing", "xai/grok-4.3"]
          : ["xai/grok-4.3"],
    });
    expect(updated?.models).toEqual({
      "xai/grok-4.7": { alias: "Grok", params: { temperature: 0.25 } },
    });
    expect(result.config.models).toEqual(cfg.models);
    expect(cfg.agents?.defaults?.models?.["xai/auto"]?.alias).toBe("Grok");
    if (scenario === "configured") {
      expect(updated?.modelPolicy?.allow).toEqual(["xai/grok-4.7", "xai/grok-4.3"]);
    }
    if (scenario === "pinned-fallback") {
      expect(result.config.agents?.entries?.main).toEqual(cfg.agents?.entries?.main);
      expect(updated?.heartbeat).toEqual(cfg.agents?.defaults?.heartbeat);
      expect(result.warnings.join("\n")).toContain("authentication route is unavailable");
    } else {
      expect(result.warnings).toEqual([]);
    }
    const repeated = repair(result.config);
    expect([repeated.config, repeated.changes]).toEqual([result.config, []]);
    if (scenario === "environment" || scenario === "configured") {
      expect(repeated.warnings).toEqual([]);
    }
    if (scenario === "environment") {
      expect(updated?.subagents?.model).toBe("xai/grok-4.7");
      expect(result.config.models).toBeUndefined();
      const resolve = createRetiredModelRefRepairResolver({ cfg, env });
      expect(resolve({ modelRef: "xai/auto@xai:missing", agentId: "main" })).toEqual({
        kind: "unchanged",
      });
    }
  },
);

it("retains env-only model selections when native catalog ownership is ambiguous", async () => {
  const { cfg, state } = await nativeFixture();
  delete cfg.models;
  delete cfg.auth;
  const env = { ...state.env, XAI_API_KEY: "synthetic-env-xai-key" };
  const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
  const xai = snapshot.byPluginId.get("xai")!;
  const competing = { ...xai, id: "competing-xai" };
  cfg.plugins!.allow!.push(competing.id);
  cfg.plugins!.entries![competing.id] = { enabled: true };
  const warnings: string[] = [];
  const resolve = createRetiredModelRefRepairResolver({
    cfg,
    env,
    warnings,
    metadataSnapshot: {
      ...snapshot,
      plugins: [...snapshot.plugins, competing],
      byPluginId: new Map([...snapshot.byPluginId, [competing.id, competing]]),
      owners: {
        ...snapshot.owners,
        modelCatalogProviders: new Map([
          ...snapshot.owners.modelCatalogProviders,
          ["xai", [xai.id, competing.id]],
        ]),
      },
    },
  });

  expect(resolve({ modelRef: "XAI/auto", agentId: "main" })).toEqual({ kind: "unchanged" });
  expect(warnings.join("\n")).toContain("authentication route is unavailable");
});

it.each(["missing-ordered-account", "unknown-oauth-endpoint"])(
  "retains selections when the native authentication route is unavailable (%s)",
  async (scenario) => {
    const { cfg, state, repair } = await nativeFixture();
    if (scenario === "missing-ordered-account") {
      await state.writeAuthProfiles({ version: 1, profiles: {} });
    } else {
      delete cfg.models;
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "xai:fixture": {
            provider: "xai",
            type: "oauth",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: 9_999_999_999_999,
          },
        },
      });
    }

    const result = repair(cfg);
    expect([result.config, result.changes]).toEqual([cfg, []]);
    expect(result.warnings.join("\n")).toContain("authentication route is unavailable");
  },
);

it.each(["provider", "model"] as const)(
  "keeps Grok on an explicit custom %s endpoint under the xAI provider",
  async (endpointOwner) => {
    const { cfg, repair } = await nativeFixture();
    const customModel = authoredModel(
      "auto",
      endpointOwner === "model" ? "https://custom.example.test/v1" : undefined,
    );
    cfg.models!.providers!.xai!.models = [customModel];
    if (endpointOwner === "provider") {
      cfg.models!.providers!.xai!.baseUrl = "https://custom.example.test/v1";
    }
    const result = repair(cfg);

    expect(result.config).toEqual(cfg);
    expect(result.config.agents?.defaults?.models?.["xai/auto"]?.alias).toBe("Grok");
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([]);
  },
);

it("keeps a missing session account pinned despite an available native xAI account", async () => {
  const { cfg, state } = await nativeFixture();
  const entry: SessionEntry = {
    sessionId: "missing-account-session",
    updatedAt: 1,
    providerOverride: "xai",
    modelOverride: "auto",
    authProfileOverride: "xai:missing",
    authProfileOverrideSource: "user",
    contextTokens: 8192,
  };
  const original = structuredClone(entry);
  const warnings: string[] = [];
  const resolve = createRetiredModelRefRepairResolver({ cfg, env: state.env, warnings });

  expect(repairRetiredSessionModelRef(entry, "main", resolve, "xai/grok-4.7", warnings)).toBe(
    false,
  );
  expect(entry).toEqual(original);
  expect(warnings).toEqual([expect.stringContaining("authentication route is unavailable")]);
});
async function useRealRoutes() {
  const routes = await import("../agents/openai-model-routes.js");
  const actual = await vi.importActual<typeof routes>("../agents/openai-model-routes.js");
  vi.spyOn(routes, "createOpenAIModelRoutesResolver").mockImplementation(
    actual.createOpenAIModelRoutesResolver,
  );
}

function repairContext(
  params: Omit<Parameters<typeof createRetiredModelRefRepairResolver>[0], "warnings">,
) {
  const warnings: string[] = [];
  const resolve = createRetiredModelRefRepairResolver({ ...params, warnings });
  return {
    warnings,
    resolve,
    repair: () => repairRetiredConfigModelRefs(params.cfg, resolve, warnings),
  };
}

// #156155: validate successors against the selected route before rewriting config.
it.each(["available", "cooldown", "authoritative-cooldown"] as const)(
  "migrates a supported successor absent from catalogs (%s)",
  async (availability) => {
    const [source, successor] = [retiredModel, currentModel];
    const { cfg, state } = await fixture(
      "oauth",
      availability === "available" ? undefined : Date.now() + 60_000,
    );
    if (availability === "authoritative-cooldown") {
      const modelAuthAvailability = await import("../agents/model-auth-availability.js");
      const createAuthResolver = modelAuthAvailability.createModelAuthAvailabilityResolver;
      vi.spyOn(modelAuthAvailability, "createModelAuthAvailabilityResolver").mockImplementation(
        (params) => {
          const resolver = createAuthResolver(params);
          return {
            ...resolver,
            evaluateRuntimeModelAuth: (provider, ref): ModelAuthAvailabilityEvaluation => {
              const result = resolver.evaluateRuntimeModelAuth(provider, ref);
              return ref?.modelId === "current-model"
                ? {
                    ...result,
                    availability: false,
                    availabilityAuthoritative: true,
                    unavailableReason: "cooldown",
                  }
                : result;
            },
          };
        },
      );
    }
    const metadataSnapshot = loadManifestMetadataSnapshot({ config: cfg, env: state.env });
    const catalog = metadataSnapshot.plugins.find((plugin) => plugin.id === "openai")?.modelCatalog
      ?.providers?.openai?.models;
    expect(catalog?.length).toBeGreaterThan(0);
    expect(catalog?.some((model) => model.id === "current-model")).toBe(false);
    expect(cfg.models?.providers?.openai?.models).toEqual([]);
    cfg.agents!.defaults!.model = { primary: source, fallbacks: [source] };
    cfg.agents!.defaults!.modelPolicy = { allow: [source] };
    const originalConfig = structuredClone(cfg);
    const { warnings, resolve, repair } = repairContext({ cfg, env: state.env, metadataSnapshot });
    expect(resolve({ modelRef: source, agentId: "main" })).toEqual({
      kind: "replace",
      modelRef: successor,
      reason: "retirement",
      retirementScope: "route",
    });
    const repaired = repair();
    expect(cfg).toEqual(originalConfig);
    expect(repaired.config.agents?.defaults).toEqual({
      model: { primary: successor, fallbacks: [successor] },
      modelPolicy: { allow: [source, successor] },
    });
    expect(warnings).toEqual([]);
  },
);

it.each(["retired-incompat-chain", "retired-global-parent", "retired-chain-to-retired"])(
  "keeps selectors, fallbacks and policy when %s has an unsupported successor",
  async (source) => {
    const { cfg, state } = await fixture("oauth");
    if (source === "retired-incompat-chain") {
      await useRealRoutes();
      cfg.models!.providers!.openai!.api = "openai-chatgpt-responses";
      cfg.models!.providers!.openai!.baseUrl = "https://chatgpt.com/backend-api/codex";
    }
    const modelRef = `openai/${source}`;
    cfg.agents!.defaults!.model = {
      primary: modelRef,
      fallbacks: [modelRef, "openai/current-model"],
    };
    cfg.agents!.defaults!.modelPolicy = { allow: [modelRef] };
    const originalConfig = structuredClone(cfg);
    const { warnings, resolve, repair } = repairContext({ cfg, env: state.env });
    expect(resolve({ modelRef, agentId: "main" })).toEqual({ kind: "unchanged" });
    const repaired = repair();
    expect(repaired.config).toEqual(originalConfig);
    expect(warnings.join("\n")).toContain("successor");
  },
);

it.each([
  ["inherited", "qualified"],
  ["local", "unqualified"],
  ["explicit-successor", "unqualified"],
] as const)("preserves runtime settings (%s, %s)", async (scope, keyForm) => {
  const { cfg, state } = await fixture("oauth");
  await useRealRoutes();
  delete cfg.models;
  const source = "openai/retired-runtime-parent";
  const sourceKey = keyForm === "qualified" ? source : "retired-runtime-parent";
  const successor = "openai/gpt-5.5";
  cfg.agents!.defaults!.model = { primary: "openai/current-model", fallbacks: [source] };
  cfg.agents!.defaults!.modelPolicy = { allow: [source, "openai/current-model"] };
  cfg.agents!.defaults!.models = {
    [sourceKey]: { agentRuntime: { id: scope === "local" ? "codex" : "agentsapi" } },
    ...(scope === "local" ? { [successor]: { agentRuntime: { id: "codex" } } } : {}),
  };
  if (scope === "local") {
    cfg.agents!.entries!.main!.models = { [sourceKey]: { agentRuntime: { id: "agentsapi" } } };
  } else if (scope === "explicit-successor") {
    cfg.agents!.entries!.main!.models = { [successor]: { agentRuntime: { id: "codex" } } };
  }
  const originalConfig = structuredClone(cfg);
  const { warnings, repair } = repairContext({ cfg, env: state.env });
  const repaired = repair();
  expect(cfg).toEqual(originalConfig);
  if (scope === "explicit-successor") {
    expect(repaired.config.agents?.defaults?.model).toEqual({
      primary: "openai/current-model",
      fallbacks: [successor],
    });
    expect(repaired.config.agents?.entries?.main?.models?.[successor]?.agentRuntime?.id).toBe(
      "codex",
    );
  } else {
    expect(repaired.config).toEqual(originalConfig);
    expect(warnings.join("\n")).toContain("successor");
  }
});

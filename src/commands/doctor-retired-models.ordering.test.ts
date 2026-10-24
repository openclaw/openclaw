import { describe, expect, it, vi } from "vitest";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronJobsStore } from "../cron/store.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { runCodexSessionRouteHealth } from "../flows/doctor-health-contribution-runners.state.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import {
  currentModel,
  noSuccessor,
  readSession,
  repairConfig,
  repairPersistedRoutes,
  retiredModel,
  seedCronModel,
  writeSession,
} from "./doctor-model-repair.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  createNativeXaiRetirementFixture as nativeFixture,
  createRetiredModelFixture as fixture,
} from "./doctor-retired-models.test-support.js";
import { createRetiredModelRefRepairResolver } from "./doctor/shared/retired-model-ref-repair.js";
import { repairRetiredSessionModelRef } from "./doctor/shared/retired-session-model-repair.js";

function expectRouteWarning(warnings: string[], model: string, detail: string) {
  for (const expected of [
    model,
    'agent "main"',
    detail,
    "allowed model override",
    "doctor --fix",
  ]) {
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

describe("doctor retirement repair ordering", () => {
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
    expect.soft(result.changes).toEqual([]);
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
});

describe("doctor retirement owner scope", () => {
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
      expect(result.config.auth).toEqual(cfg.auth);
      expect(result.config.models).toEqual(cfg.models);
      expect(result.warnings).toEqual([]);
      const repeated = repair(result.config);
      expect(repeated.config).toEqual(result.config);
      expect(repeated.changes).toEqual([]);
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
      expect(repeated.config).toEqual(result.config);
      expect(repeated.changes).toEqual([]);
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
      expect(result.config).toEqual(cfg);
      expect(result.changes).toEqual([]);
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

  it("preserves a shared alias when another physical route still accepts its old model", async () => {
    const { cfg, state } = await fixture();
    cfg.agents!.defaults!.model = "retired-alias";
    cfg.agents!.defaults!.models = {
      [retiredModel]: { alias: "retired-alias", params: { temperature: 0.25 } },
    };
    cfg.agents!.defaults!.modelPolicy = { allow: [retiredModel] };
    const repair = (config: OpenClawConfig) => repairConfig(config, state.env);
    const result = repair(cfg);
    const updated = result.config.agents?.defaults;

    expect(updated?.model).toBe(currentModel);
    expect(updated?.models).toEqual({
      [retiredModel]: { alias: "retired-alias", params: { temperature: 0.25 } },
      [currentModel]: { params: { temperature: 0.25 } },
    });
    expect(updated?.modelPolicy?.allow).toEqual([retiredModel, currentModel]);
    expect(result.warnings.join("\n")).toContain("do not share a verified successor");
    const repeated = repair(result.config);
    expect(repeated.config).toEqual(result.config);
    expect(repeated.changes).toEqual([]);
  });
});

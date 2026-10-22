import { describe, expect, it } from "vitest";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { buildAllowedModelSet } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import {
  applySystemAgentModelSelection,
  projectSetupInferenceConfig,
} from "./setup-model-selection.js";

type Selection = Parameters<typeof applySystemAgentModelSelection>[0];
type Agents = NonNullable<OpenClawConfig["agents"]>;
function select(config: OpenClawConfig, options: Partial<Omit<Selection, "config">> = {}) {
  return applySystemAgentModelSelection({ config, model: "openai/gpt-5.5", ...options });
}
function agentConfig(defaults: Agents["defaults"], entries: Agents["entries"]): OpenClawConfig {
  return { agents: { defaults, entries } };
}
type Credential = Extract<AuthProfileCredential, { type: "api_key" | "token" }>;
type CredentialCase = [string, Credential, SecretInput, SecretInput?];
const model = "openai/gpt-5.5";

describe("projectSetupInferenceConfig", () => {
  const profileId = "omlx:setup-proof";
  const keyRef = { source: "env", provider: "default", id: "OMLX_API_KEY" } as const;
  const referencedCredential = { type: "api_key", provider: "omlx", keyRef } as const;
  const apiKeyCredential = (key: string, provider = "omlx") =>
    ({ type: "api_key", provider, key }) as const;
  const providerConfig = (port: number, apiKey?: SecretInput) => ({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey,
    models: [],
  });
  const providers = (
    entries: NonNullable<OpenClawConfig["models"]>["providers"],
  ): OpenClawConfig => ({ models: { providers: entries } });

  it.each<CredentialCase>([
    ["core no-auth marker", apiKeyCredential("custom-local", "custom-studio"), "custom-local"],
    ["bundled oMLX no-auth marker", apiKeyCredential("omlx-local"), "omlx-local"],
    ["literal API key", apiKeyCredential("synthetic-api-key"), profileId],
    ["real token", { type: "token", provider: "omlx", token: "synthetic-token" }, profileId],
    ["environment marker", apiKeyCredential("OMLX_API_KEY"), profileId],
    [
      "environment SecretRef",
      referencedCredential,
      { source: "env", provider: "default", id: "OMLX_API_KEY" },
    ],
    ["environment template reference", referencedCredential, "${OMLX_API_KEY}", "${OMLX_API_KEY}"],
    ["profile binding backed by a SecretRef", referencedCredential, profileId, profileId],
  ])(
    "preserves credential semantics for %s",
    (_name, credential, expectedApiKey, providerApiKey) => {
      const provider = credential.provider;
      const prepared = providers({
        [provider.toUpperCase()]: providerConfig(8003, "stale-prepared-alias"),
        [provider]: providerConfig(
          8000,
          providerApiKey ??
            (credential.type === "token"
              ? credential.token
              : (credential.key ?? credential.keyRef)),
        ),
      });

      const projected = projectSetupInferenceConfig({
        base: providers({
          [provider.toUpperCase()]: providerConfig(8001, "old-alias-key"),
          [provider]: providerConfig(8002, "old-canonical-key"),
          sibling: { baseUrl: "http://127.0.0.1:9000/v1", models: [] },
        }),
        prepared,
        modelRef: `${provider}/local-model`,
        agentId: "main",
        profileId,
        credential,
      });

      expect(projected.models?.providers).toEqual({
        sibling: { baseUrl: "http://127.0.0.1:9000/v1", models: [] },
        [provider]: { ...prepared.models?.providers?.[provider], apiKey: expectedApiKey },
      });
    },
  );
});

describe("applySystemAgentModelSelection", () => {
  it("adds a utility without changing other bindings", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          systemAgent: { agentId: "main" },
          model: {
            primary: "openai/gpt-5.5@openai:primary",
            fallbacks: ["openai/gpt-5.4@openai:backup"],
          },
          models: { [model]: { agentRuntime: { id: "codex" } } },
        },
        entries: {
          main: { agentDir: "/tmp/main-auth" },
          ops: { model: "openai/gpt-5.4" },
        },
      },
      auth: {
        profiles: {
          "openai:primary": { provider: "openai", mode: "api_key" },
          "openai:utility": { provider: "openai", mode: "api_key" },
        },
        order: { openai: ["openai:primary", "openai:utility"] },
      },
    };
    const original = structuredClone(config);

    const result = await select(config, {
      modelTarget: "utility",
      authProfileId: "openai:utility",
    });

    expect(config).toEqual(original);
    original.agents!.defaults!.utilityModel = `${model}@openai:utility`;
    expect({ agents: result.agents, auth: result.auth }).toEqual(original);
  });

  it("writes a utility selection only to its agent owner", async () => {
    const config = agentConfig(
      {
        systemAgent: { agentId: "ops" },
        model,
        utilityModel: "local-utility/shared",
      },
      {
        main: {},
        ops: {
          model: { primary: "openai/gpt-5.4", fallbacks: [model] },
          agentDir: "/tmp/ops-auth",
        },
      },
    );

    const result = await select(config, {
      model: "local-utility/tiny",
      modelTarget: "utility",
      targetAgentId: "ops",
    });

    expect(result.agents?.defaults).toEqual(config.agents?.defaults);
    expect(result.agents?.entries?.main).toEqual(config.agents?.entries?.main);
    expect(result.agents?.entries?.ops).toEqual({
      ...config.agents?.entries?.ops,
      utilityModel: "local-utility/tiny",
      models: { "local-utility/tiny": {} },
    });
  });

  it.each(["defaults", "agent"] as const)(
    "keeps %s utility fallbacks when setup replaces the primary",
    async (owner) => {
      const utilityModel = { primary: "local/old", fallbacks: ["local/backup"] };
      const config = agentConfig(
        { utilityModel },
        { main: owner === "agent" ? { utilityModel } : {} },
      );
      const result = await select(config, { model: "local/new", modelTarget: "utility" });
      expect(
        owner === "agent"
          ? result.agents?.entries?.main?.utilityModel
          : result.agents?.defaults?.utilityModel,
      ).toEqual({ primary: "local/new", fallbacks: ["local/backup"] });
    },
  );

  it("keeps a newly approved model allowed when migrating a first-run legacy model map", async () => {
    const cfg = await select(
      { agents: { defaults: { models: { "fixture/old": {} } } } },
      { model: "fixture/new", agentRuntimeId: "openclaw", runtimeInDefaults: true },
    );
    const allowed = buildAllowedModelSet({ cfg, catalog: [], defaultProvider: "fixture" });
    expect(allowed.allows({ provider: "fixture", model: "new" })).toBe(true);
    expect(allowed.allows({ provider: "fixture", model: "old" })).toBe(true);
    expect(allowed.allows({ provider: "fixture", model: "unapproved" })).toBe(false);
  });

  it("rejects an unrepresentable explicit agent instead of updating main", async () => {
    const config = agentConfig(undefined, { main: {}, ops: {} });

    await expect(select(config, { targetAgentId: "агент✨" })).rejects.toThrow(
      'Could not resolve configured agent "агент✨".',
    );
    expect(config.agents?.entries?.main).toEqual({});
  });

  it("updates the primary selection to the native runtime without changing unrelated bindings", async () => {
    const config = agentConfig(
      { models: { [model]: { agentRuntime: { id: "codex" } } } },
      {
        work: {
          model,
          models: { [model]: { alias: "primary", agentRuntime: { id: "codex" } } },
        },
      },
    );
    const result = await select(config);
    expect(result.agents?.defaults?.models?.[model]?.agentRuntime).toBeUndefined();
    expect(result.agents?.entries?.work).toEqual({
      model,
      models: { [model]: { alias: "primary" } },
    });
  });
});

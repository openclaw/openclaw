import { describe, expect, it } from "vitest";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { buildAllowedModelSet } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import {
  applySystemAgentModelSelection,
  projectSetupInferenceConfig,
} from "./setup-model-selection.js";

describe("projectSetupInferenceConfig", () => {
  const profileId = "omlx:setup-proof";

  it.each<{
    name: string;
    credential: Extract<AuthProfileCredential, { type: "api_key" | "token" }>;
    providerApiKey?: SecretInput;
    expectedApiKey: SecretInput;
  }>([
    {
      name: "core no-auth marker",
      credential: { type: "api_key", provider: "custom-studio", key: "custom-local" },
      expectedApiKey: "custom-local",
    },
    {
      name: "bundled oMLX no-auth marker",
      credential: { type: "api_key", provider: "omlx", key: "omlx-local" },
      expectedApiKey: "omlx-local",
    },
    {
      name: "literal API key",
      credential: { type: "api_key", provider: "omlx", key: "synthetic-api-key" },
      expectedApiKey: profileId,
    },
    {
      name: "real token",
      credential: { type: "token", provider: "omlx", token: "synthetic-token" },
      expectedApiKey: profileId,
    },
    {
      name: "environment marker",
      credential: { type: "api_key", provider: "omlx", key: "OMLX_API_KEY" },
      expectedApiKey: profileId,
    },
    {
      name: "environment SecretRef",
      credential: {
        type: "api_key",
        provider: "omlx",
        keyRef: { source: "env", provider: "default", id: "OMLX_API_KEY" },
      },
      expectedApiKey: { source: "env", provider: "default", id: "OMLX_API_KEY" },
    },
    {
      name: "environment template reference",
      credential: {
        type: "api_key",
        provider: "omlx",
        keyRef: { source: "env", provider: "default", id: "OMLX_API_KEY" },
      },
      providerApiKey: "${OMLX_API_KEY}",
      expectedApiKey: "${OMLX_API_KEY}",
    },
    {
      name: "profile binding backed by a SecretRef",
      credential: {
        type: "api_key",
        provider: "omlx",
        keyRef: { source: "env", provider: "default", id: "OMLX_API_KEY" },
      },
      providerApiKey: profileId,
      expectedApiKey: profileId,
    },
  ])(
    "preserves credential semantics for $name",
    ({ credential, providerApiKey, expectedApiKey }) => {
      const provider = credential.provider;
      const prepared: OpenClawConfig = {
        models: {
          providers: {
            [provider.toUpperCase()]: {
              baseUrl: "http://127.0.0.1:8003/v1",
              apiKey: "stale-prepared-alias",
              models: [],
            },
            [provider]: {
              baseUrl: "http://127.0.0.1:8000/v1",
              apiKey:
                providerApiKey ??
                (credential.type === "token"
                  ? credential.token
                  : (credential.key ?? credential.keyRef)),
              models: [],
            },
          },
        },
      };

      const projected = projectSetupInferenceConfig({
        base: {
          models: {
            providers: {
              [provider.toUpperCase()]: {
                baseUrl: "http://127.0.0.1:8001/v1",
                apiKey: "old-alias-key",
                models: [],
              },
              [provider]: {
                baseUrl: "http://127.0.0.1:8002/v1",
                apiKey: "old-canonical-key",
                models: [],
              },
              sibling: { baseUrl: "http://127.0.0.1:9000/v1", models: [] },
            },
          },
        },
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
          models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
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

    const result = await applySystemAgentModelSelection({
      config,
      model: "openai/gpt-5.5",
      modelTarget: "utility",
      authProfileId: "openai:utility",
    });

    expect(result.agents?.defaults).toEqual({
      ...config.agents?.defaults,
      utilityModel: "openai/gpt-5.5@openai:utility",
    });
    expect(result.agents?.entries).toEqual(config.agents?.entries);
    expect(result.auth).toEqual(config.auth);
    expect(config).toEqual(original);
  });

  it("writes a utility selection only to its agent owner", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          systemAgent: { agentId: "ops" },
          model: "openai/gpt-5.5",
          utilityModel: "local-utility/shared",
        },
        entries: {
          main: {},
          ops: {
            model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.5"] },
            agentDir: "/tmp/ops-auth",
          },
        },
      },
    };

    const result = await applySystemAgentModelSelection({
      config,
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
      const config: OpenClawConfig = {
        agents: {
          defaults: { utilityModel },
          entries: { main: owner === "agent" ? { utilityModel } : {} },
        },
      };
      const result = await applySystemAgentModelSelection({
        config,
        model: "local/new",
        modelTarget: "utility",
      });
      expect(
        owner === "agent"
          ? result.agents?.entries?.main?.utilityModel
          : result.agents?.defaults?.utilityModel,
      ).toEqual({ primary: "local/new", fallbacks: ["local/backup"] });
    },
  );

  it("keeps a newly approved model allowed when migrating a first-run legacy model map", async () => {
    const cfg = await applySystemAgentModelSelection({
      config: { agents: { defaults: { models: { "fixture/old": {} } } } },
      model: "fixture/new",
      agentRuntimeId: "openclaw",
      runtimeInDefaults: true,
    });
    const allowed = buildAllowedModelSet({ cfg, catalog: [], defaultProvider: "fixture" });
    expect(allowed.allows({ provider: "fixture", model: "new" })).toBe(true);
    expect(allowed.allows({ provider: "fixture", model: "old" })).toBe(true);
    expect(allowed.allows({ provider: "fixture", model: "unapproved" })).toBe(false);
  });

  it("rejects an unrepresentable explicit agent instead of updating main", async () => {
    const config = {
      agents: {
        entries: { main: {}, ops: {} },
      },
    } satisfies OpenClawConfig;

    await expect(
      applySystemAgentModelSelection({
        config,
        model: "openai/gpt-5.5",
        targetAgentId: "агент✨",
      }),
    ).rejects.toThrow('Could not resolve configured agent "агент✨".');
    expect(config.agents.entries.main).toEqual({});
  });

  it("updates the primary selection to the native runtime without changing unrelated bindings", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
        entries: {
          work: {
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": { alias: "primary", agentRuntime: { id: "codex" } },
            },
          },
        },
      },
    };
    const result = await applySystemAgentModelSelection({
      config,
      model: "openai/gpt-5.5",
    });
    expect(result.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toBeUndefined();
    expect(result.agents?.entries?.work?.models?.["openai/gpt-5.5"]).toEqual({
      alias: "primary",
    });
    expect(result.agents?.entries?.work?.model).toBe("openai/gpt-5.5");
  });
});

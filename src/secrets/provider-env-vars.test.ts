/** Tests provider env-var candidate and auth evidence lookup. */
import { describe, expect, it } from "vitest";
import {
  makeEmptyPluginMetadataOwners,
  makePluginMetadataIndex,
  makePluginMetadataManifestRegistry,
} from "../plugins/current-plugin-metadata.test-support.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { buildPluginMetadataProviderFacts } from "../plugins/plugin-metadata-provider-facts.js";
import {
  getProviderEnvVarsCore,
  listKnownProviderAuthEnvVarNamesCore,
  listKnownSecretEnvVarNames,
  omitEnvKeysCaseInsensitive,
} from "./provider-env-vars.js";

describe("provider env vars", () => {
  it("keeps provider credentials in auth and secret inventories", () => {
    const sharedSecretNames = [
      "ANTHROPIC_OAUTH_TOKEN",
      "BRAVE_API_KEY",
      "DEEPGRAM_API_KEY",
      "FIRECRAWL_API_KEY",
      "GROQ_API_KEY",
      "PERPLEXITY_API_KEY",
      "OPENROUTER_API_KEY",
      "TAVILY_API_KEY",
    ];
    const providerAuthNames = listKnownProviderAuthEnvVarNamesCore();
    const secretNames = listKnownSecretEnvVarNames();
    for (const name of sharedSecretNames) {
      expect(providerAuthNames).toContain(name);
      expect(secretNames).toContain(name);
    }
    expect(providerAuthNames).toContain("MINIMAX_CODE_PLAN_KEY");
    expect(providerAuthNames).toContain("MINIMAX_CODING_API_KEY");
    expect(providerAuthNames).toContain("OPENAI_ADMIN_KEY");
    expect(providerAuthNames).toContain("ANTHROPIC_ADMIN_KEY");
    expect(providerAuthNames).toContain("ANTHROPIC_ADMIN_API_KEY");
    expect(secretNames).toContain("OPENAI_ADMIN_KEY");
    expect(secretNames).toContain("ANTHROPIC_ADMIN_KEY");
    expect(secretNames).toContain("ANTHROPIC_ADMIN_API_KEY");
    expect(listKnownSecretEnvVarNames()).not.toContain("OPENCLAW_API_KEY");
  });

  it.each(["GH_TOKEN", "GITHUB_TOKEN"])("audits %s without activating a provider", (name) => {
    expect(listKnownSecretEnvVarNames()).toContain(name);
    expect(listKnownProviderAuthEnvVarNamesCore()).not.toContain(name);
    expect(getProviderEnvVarsCore("github-copilot")).not.toContain(name);
  });

  it("omits env keys case-insensitively", () => {
    const env = omitEnvKeysCaseInsensitive(
      {
        OpenAI_Api_Key: "openai-secret",
        Github_Token: "gh-secret",
        OPENCLAW_API_KEY: "keep-me",
      },
      ["OPENAI_API_KEY", "GITHUB_TOKEN"],
    );

    expect(env.OpenAI_Api_Key).toBeUndefined();
    expect(env.Github_Token).toBeUndefined();
    expect(env.OPENCLAW_API_KEY).toBe("keep-me");
  });

  it("ignores prototype-chain keys when resolving provider env vars", () => {
    expect(getProviderEnvVarsCore("__proto__")).toStrictEqual([]);
    expect(getProviderEnvVarsCore("constructor")).toStrictEqual([]);
    expect(getProviderEnvVarsCore("openai")).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
    expect(getProviderEnvVarsCore("anthropic")).toEqual([
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
    expect(getProviderEnvVarsCore("fal")).toEqual(["FAL_KEY", "FAL_API_KEY"]);
  });

  // A manifest may declare a prototype-named provider id. The id is a key in the
  // candidate buckets, so those buckets must be prototype-less: otherwise the name
  // resolves an inherited member, `new Set(bucket)` throws, and the declared
  // credentials disappear from the secret inventory that sandbox filtering and
  // `.env` auditing consume.
  const prototypeNamedProviders = [
    {
      id: "__proto__",
      envVars: ["ACME_CREDENTIAL"],
      authEvidence: [{ type: "local-file-with-env" }],
    },
    { id: "constructor", envVars: ["CTOR_CREDENTIAL"] },
    { id: "prototype", envVars: ["PROTO_CREDENTIAL"] },
  ];

  function prototypeSnapshot() {
    const plugin: PluginManifestRecord = {
      ...makePluginMetadataManifestRegistry("prototype-named-providers").plugins[0]!,
      setup: { providers: prototypeNamedProviders },
    };
    const providerFacts = buildPluginMetadataProviderFacts([plugin]);
    return {
      config: {},
      metadataSnapshot: {
        index: makePluginMetadataIndex("prototype-named-providers"),
        manifestRegistry: { plugins: [plugin], diagnostics: [] },
        byPluginId: new Map([[plugin.id, plugin]]),
        plugins: [plugin],
        owners: {
          ...makeEmptyPluginMetadataOwners(),
          providerAuthContributions: providerFacts.providerAuthContributions,
          providerAuthAliases: providerFacts.providerAuthAliases,
        },
      },
    } as never;
  }

  it("keeps prototype-named provider ids addressable instead of crashing the inventory", () => {
    const params = prototypeSnapshot();
    expect(() => listKnownSecretEnvVarNames(params)).not.toThrow();
    const secretNames = listKnownSecretEnvVarNames(params);
    for (const name of ["ACME_CREDENTIAL", "CTOR_CREDENTIAL", "PROTO_CREDENTIAL"]) {
      expect(secretNames).toContain(name);
    }
    expect(getProviderEnvVarsCore("__proto__", params)).toEqual(["ACME_CREDENTIAL"]);
    expect(getProviderEnvVarsCore("constructor", params)).toEqual(["CTOR_CREDENTIAL"]);
    expect(getProviderEnvVarsCore("prototype", params)).toEqual(["PROTO_CREDENTIAL"]);
  });
});

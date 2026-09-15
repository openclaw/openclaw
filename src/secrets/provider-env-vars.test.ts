/** Tests provider env-var candidate and auth evidence lookup. */
import { describe, expect, it } from "vitest";
import {
  getProviderEnvVars,
  listKnownProviderAuthEnvVarNames,
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
    const providerAuthNames = listKnownProviderAuthEnvVarNames();
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
    expect(listKnownProviderAuthEnvVarNames()).not.toContain(name);
    expect(getProviderEnvVars("github-copilot")).not.toContain(name);
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
    expect(getProviderEnvVars("__proto__")).toStrictEqual([]);
    expect(getProviderEnvVars("constructor")).toStrictEqual([]);
    expect(getProviderEnvVars("openai")).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
    expect(getProviderEnvVars("anthropic")).toEqual(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    expect(getProviderEnvVars("fal")).toEqual(["FAL_KEY", "FAL_API_KEY"]);
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
    return {
      config: {},
      metadataSnapshot: {
        plugins: [
          {
            id: "prototype-named-providers",
            origin: "global",
            setup: { providers: prototypeNamedProviders },
          },
        ],
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
    expect(getProviderEnvVars("__proto__", params)).toEqual(["ACME_CREDENTIAL"]);
    expect(getProviderEnvVars("constructor", params)).toEqual(["CTOR_CREDENTIAL"]);
    expect(getProviderEnvVars("prototype", params)).toEqual(["PROTO_CREDENTIAL"]);
  });
});

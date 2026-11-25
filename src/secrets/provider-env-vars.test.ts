/** Tests provider env-var candidate and auth evidence lookup. */
import { describe, expect, it } from "vitest";
import {
  getProviderEnvVarsCore,
  listKnownProviderAuthEnvVarNamesCore,
  listKnownSecretEnvVarNames,
  omitEnvKeysCaseInsensitive,
} from "./provider-env-vars.js";

describe("provider env vars", () => {
  it.each(["GITHUB_TOKEN"])("audits %s without activating a provider", (name) => {
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
});

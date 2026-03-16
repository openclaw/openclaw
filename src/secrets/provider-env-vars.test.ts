import { describe, expect, it } from "vitest";
import {
  listKnownProviderAuthEnvVarNames,
  listKnownSecretEnvVarNames,
  omitEnvKeysCaseInsensitive,
} from "./provider-env-vars.js";

describe("provider env vars", () => {
  it("keeps the auth scrub list broader than the global secret env list", () => {
    expect(listKnownProviderAuthEnvVarNames()).toEqual(
      expect.arrayContaining(["GITHUB_TOKEN", "GH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]),
    );
    expect(listKnownSecretEnvVarNames()).toEqual(
      expect.arrayContaining(["GITHUB_TOKEN", "GH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]),
    );
    expect(listKnownProviderAuthEnvVarNames()).toEqual(
      expect.arrayContaining(["MINIMAX_CODE_PLAN_KEY"]),
    );
    expect(listKnownSecretEnvVarNames()).not.toContain("OPENCLAW_API_KEY");
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
});

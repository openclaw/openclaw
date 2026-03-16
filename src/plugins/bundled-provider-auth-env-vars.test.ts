import { describe, expect, it } from "vitest";
import { BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES } from "./bundled-provider-auth-env-vars.js";

describe("bundled provider auth env vars", () => {
  it("reads bundled provider auth env vars from plugin manifests", () => {
    expect(BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES["github-copilot"]).toEqual([
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ]);
    expect(BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES["qwen-portal"]).toEqual([
      "QWEN_OAUTH_TOKEN",
      "QWEN_PORTAL_API_KEY",
    ]);
    expect(BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES["minimax-portal"]).toEqual([
      "MINIMAX_OAUTH_TOKEN",
      "MINIMAX_API_KEY",
    ]);
    expect(BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES.openai).toEqual(["OPENAI_API_KEY"]);
    expect(BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES["openai-codex"]).toBeUndefined();
  });
});

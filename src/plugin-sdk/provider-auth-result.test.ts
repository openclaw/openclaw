import { describe, expect, it } from "vitest";
import { buildOauthProviderAuthResult } from "./provider-auth-result.js";

describe("buildOauthProviderAuthResult", () => {
  it("does not inject a models config patch by default", () => {
    const result = buildOauthProviderAuthResult({
      providerId: "openai-codex",
      defaultModel: "openai-codex/gpt-5.4",
      access: "access-token",
      refresh: "refresh-token",
      email: "user@example.com",
    });

    expect(result).toMatchObject({
      profiles: [
        {
          profileId: "openai-codex:user@example.com",
          credential: expect.objectContaining({
            provider: "openai-codex",
            email: "user@example.com",
          }),
        },
      ],
      configPatch: undefined,
      defaultModel: "openai-codex/gpt-5.4",
    });
  });

  it("preserves explicit provider-owned config patches", () => {
    const configPatch = {
      agents: {
        defaults: {
          models: {
            "demo/model": { alias: "demo" },
          },
        },
      },
    };

    const result = buildOauthProviderAuthResult({
      providerId: "demo",
      defaultModel: "demo/model",
      access: "access-token",
      configPatch,
    });

    expect(result.configPatch).toEqual(configPatch);
  });
});

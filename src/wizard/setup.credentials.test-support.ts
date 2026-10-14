import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { readAuthProfileStoreForTest } from "../agents/auth-profiles/oauth-test-utils.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function modelConfigWithApiKey(apiKey: string, agentDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" } },
      entries: { main: { agentDir } },
    },
    auth: {
      profiles: { "openai:default": { provider: "openai", mode: "api_key" } },
      order: { openai: ["openai:default"] },
    },
    models: {
      providers: {
        openai: {
          apiKey,
          baseUrl: "https://api.openai.com/v1",
          models: [],
        },
      },
    },
  };
}

export function openAiAuthProfile(apiKey: string) {
  return {
    profileId: "openai:default",
    credential: { type: "api_key" as const, provider: "openai", key: apiKey },
  };
}

export function expectSavedSetupCredential(
  config: OpenClawConfig,
  agentDir: string,
  key: string,
): string {
  const primary = expectDefined(
    resolveAgentModelPrimaryValue(config.agents?.defaults?.model),
    "selected model",
  );
  const profileId = expectDefined(
    splitTrailingAuthProfile(primary).profile,
    "selected credential profile",
  );
  expect(profileId).toMatch(/^openai:setup-/);
  const { setup, ...credential } = expectDefined(
    readAuthProfileStoreForTest(agentDir).profiles[profileId],
    "saved credential profile",
  );
  expect(credential).toEqual(openAiAuthProfile(key).credential);
  if (setup) {
    expect(setup).toMatchObject({
      modelRef: "openai/gpt-5.5",
      replacement: expect.any(Boolean),
      configJson: expect.any(String),
    });
  }
  return profileId;
}

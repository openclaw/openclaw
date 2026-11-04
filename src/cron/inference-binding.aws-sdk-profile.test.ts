import { expect, it } from "vitest";
import { createTestModelDefinition } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  acquireCronInferenceAuthorization,
  captureCronInferenceBinding,
} from "./inference-binding.runtime.js";

const PROFILE_ID = "amazon-bedrock:aws-sdk";
const MODEL_ID = "anthropic.claude-sonnet-4-20250514-v1:0";

function config(agentDir: string, declared: boolean): OpenClawConfig {
  return {
    agents: {
      entries: { main: { agentDir } },
      defaults: { model: `amazon-bedrock/${MODEL_ID}` },
    },
    models: {
      providers: {
        "amazon-bedrock": {
          auth: "aws-sdk",
          api: "bedrock-converse-stream",
          baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
          models: [createTestModelDefinition(MODEL_ID)],
        },
      },
    },
    ...(declared
      ? {
          auth: {
            profiles: { [PROFILE_ID]: { provider: "amazon-bedrock", mode: "aws-sdk" } },
          },
        }
      : {}),
  };
}

function withBedrockState(
  run: (state: { agentDir: string; cfg: OpenClawConfig }) => Promise<void>,
) {
  return withOpenClawTestState({ label: "bedrock-aws-sdk-binding" }, async (state) => {
    await state.writeAuthProfiles({ version: 1, profiles: {} });
    const agentDir = state.agentDir("main");
    await run({
      agentDir,
      cfg: config(agentDir, true),
    });
  });
}

it("records the declared AWS SDK account for a scheduled Bedrock run", async () => {
  await withBedrockState(async ({ agentDir, cfg }) => {
    const binding = await captureCronInferenceBinding({ cfg, agentId: "main" });
    expect(binding).toMatchObject({
      version: 1,
      provider: "amazon-bedrock",
      profileId: PROFILE_ID,
      authRequirement: "api-key",
      source: "auto",
    });
    expect(binding?.authorizationId).toMatch(/^[a-f0-9]{64}$/u);
    // The declaration is the account: no AWS material reaches the recorded binding.
    expect(JSON.stringify(binding)).not.toMatch(/AKIA|ASIA|SecretAccessKey|SessionToken/u);

    // Every later run reacquires the same authorization from config alone.
    const authority = await acquireCronInferenceAuthorization({ binding: binding!, cfg, agentDir });
    try {
      expect(authority.authorizationId).toBe(binding?.authorizationId);
    } finally {
      authority.dispose();
    }
  });
});

it("refuses the account once config stops declaring it", async () => {
  await withBedrockState(async ({ agentDir, cfg }) => {
    const binding = await captureCronInferenceBinding({ cfg, agentId: "main" });
    await expect(
      acquireCronInferenceAuthorization({
        binding: binding!,
        cfg: config(agentDir, false),
        agentDir,
      }),
    ).rejects.toThrow("was removed or signed out");
  });
});

it("keeps an undeclared AWS SDK route unbound", async () => {
  await withBedrockState(async ({ agentDir }) => {
    await expect(
      captureCronInferenceBinding({ cfg: config(agentDir, false), agentId: "main" }),
    ).rejects.toThrow("Automation requires a stored inference account");
  });
});

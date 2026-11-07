import { expect, it } from "vitest";
import { createTestModelDefinition } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  acquireCronInferenceAuthorization,
  captureCronInferenceBinding,
} from "./inference-binding.runtime.js";

const PROFILE_ID = "amazon-bedrock:aws-sdk";
const MODEL_ID = "anthropic.claude-sonnet-4-20250514-v1:0";
const MARKER = { type: "api_key", provider: "amazon-bedrock", key: "aws-sdk-credentials" } as const;

function config(agentDir: string): OpenClawConfig {
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
  };
}

function withBedrockState(
  run: (state: {
    agentDir: string;
    cfg: OpenClawConfig;
    writeAccount: OpenClawTestState["writeAuthProfiles"];
  }) => Promise<void>,
) {
  return withOpenClawTestState({ label: "bedrock-aws-sdk-binding" }, async (state) => {
    const agentDir = state.agentDir("main");
    await state.writeAuthProfiles({ version: 1, profiles: { [PROFILE_ID]: MARKER } });
    await run({ agentDir, cfg: config(agentDir), writeAccount: state.writeAuthProfiles });
  });
}

it("records the stored AWS SDK account for a scheduled Bedrock run", async () => {
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
    // The record is the account: no AWS material reaches the recorded binding.
    expect(JSON.stringify(binding)).not.toMatch(/AKIA|ASIA|SecretAccessKey|SessionToken/u);

    // The account is unchanged, so every later run reacquires the same authorization.
    const authority = await acquireCronInferenceAuthorization({ binding: binding!, cfg, agentDir });
    try {
      expect(authority.authorizationId).toBe(binding?.authorizationId);
    } finally {
      authority.dispose();
    }
  });
});

it.each([
  ["removed", "was removed or signed out"],
  ["recreated under the same id", "was replaced"],
] as const)("refuses a binding after its account is %s", async (outcome, refusal) => {
  await withBedrockState(async ({ agentDir, cfg, writeAccount }) => {
    const binding = await captureCronInferenceBinding({ cfg, agentId: "main" });
    // Signing out retires the record; recreating the same id issues a new
    // incarnation, so the old binding is refused either way.
    await writeAccount({ version: 1, profiles: {} });
    if (outcome === "recreated under the same id") {
      await writeAccount({ version: 1, profiles: { [PROFILE_ID]: MARKER } });
    }
    await expect(
      acquireCronInferenceAuthorization({ binding: binding!, cfg, agentDir }),
    ).rejects.toThrow(refusal);
  });
});

it("keeps an AWS SDK route with no stored account unbound", async () => {
  await withBedrockState(async ({ cfg, writeAccount }) => {
    await writeAccount({ version: 1, profiles: {} });
    await expect(captureCronInferenceBinding({ cfg, agentId: "main" })).rejects.toThrow(
      "Automation requires a stored inference account",
    );
  });
});

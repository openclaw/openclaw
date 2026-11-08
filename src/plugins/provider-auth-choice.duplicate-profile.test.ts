import { expect, it } from "vitest";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { createRuntimeEnv, createTestWizardPrompter } from "../plugin-sdk/plugin-test-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runProviderPluginAuthMethod } from "./provider-auth-choice.js";

it.each([true, false])(
  "validates the persisted last duplicate entry (compatible=%s)",
  async (compatible) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profileId = "fixture:duplicate";
      const current: AuthProfileCredential = {
        provider: "fixture",
        type: "token",
        token: "synthetic-current",
      };
      const other: AuthProfileCredential = {
        provider: "other",
        type: "token",
        token: "synthetic-other",
      };
      const profiles = (compatible ? [other, current] : [current, other]).map((credential) => ({
        profileId,
        credential,
      }));
      const agentDir = state.agentDir("child");
      const attempt = runProviderPluginAuthMethod({
        config: {},
        providerId: "fixture",
        agentDir,
        workspaceDir: state.workspaceDir,
        env: state.env,
        runtime: createRuntimeEnv(),
        prompter: createTestWizardPrompter(),
        method: {
          id: "duplicate",
          label: "Duplicate fixture",
          kind: "token",
          run: async () => ({ profiles }),
        },
        beforePersistentEffect: async () => {
          await persistAuthProfileBatch({
            agentDir,
            profiles: [{ profileId, credential: current }],
          });
        },
      });
      if (compatible) {
        await expect(attempt).resolves.toBeDefined();
      } else {
        await expect(attempt).rejects.toThrow(/changed.*retry/i);
      }
      expect(
        (await loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir)).profiles[profileId],
      ).toEqual(current);
    });
  },
);

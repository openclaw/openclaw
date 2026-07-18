/** Tests secrets runtime refresh handling for auth-profile stores. */
import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import {
  beginSecretsRuntimeIsolationForTest,
  createOpenAIFileRuntimeConfig,
  createOpenAIFileRuntimeFixture,
  EMPTY_LOADABLE_PLUGIN_ORIGINS,
  endSecretsRuntimeIsolationForTest,
  expectResolvedOpenAIRuntime,
  loadAuthStoreWithProfiles,
  OPENAI_FILE_KEY_REF,
  type SecretsRuntimeEnvSnapshot,
} from "./runtime-auth.integration.test-helpers.js";
import { listSecretResolutionErrorOwners } from "./runtime-degraded-state.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
} from "./runtime.js";

vi.unmock("../version.js");

function expectActiveSecretsRuntimeSnapshot(): NonNullable<
  ReturnType<typeof getActiveSecretsRuntimeSnapshot>
> {
  const snapshot = getActiveSecretsRuntimeSnapshot();
  if (snapshot === null) {
    throw new Error("Expected active secrets runtime snapshot");
  }
  return snapshot;
}

describe("secrets runtime snapshot auth refresh failure", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
  });

  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  it("keeps last-known-good runtime snapshot active when refresh preparation fails", async () => {
    if (os.platform() === "win32") {
      return;
    }
    await withTempHome("openclaw-secrets-runtime-refresh-fail-", async (home) => {
      const { secretFile, agentDir } = await createOpenAIFileRuntimeFixture(home);

      let loadAuthStoreCalls = 0;
      const loadAuthStore = () => {
        loadAuthStoreCalls += 1;
        if (loadAuthStoreCalls > 1) {
          throw new Error("simulated secrets runtime refresh failure");
        }
        return loadAuthStoreWithProfiles({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: OPENAI_FILE_KEY_REF,
          },
        });
      };

      const prepared = await prepareSecretsRuntimeSnapshot({
        config: createOpenAIFileRuntimeConfig(secretFile),
        agentDirs: [agentDir],
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
        loadAuthStore,
      });

      activateSecretsRuntimeSnapshot(prepared);
      expectResolvedOpenAIRuntime(agentDir);

      await expect(
        prepareSecretsRuntimeSnapshot({
          config: {
            ...createOpenAIFileRuntimeConfig(secretFile),
            gateway: { auth: { mode: "token" } },
          },
          agentDirs: [agentDir],
          loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
          loadAuthStore,
        }),
      ).rejects.toThrow(/simulated secrets runtime refresh failure/i);

      const activeAfterFailure = expectActiveSecretsRuntimeSnapshot();
      expectResolvedOpenAIRuntime(agentDir);
      expect(activeAfterFailure.sourceConfig.models?.providers?.openai?.apiKey).toEqual(
        OPENAI_FILE_KEY_REF,
      );
    });
  });

  it("classifies a changed auth-profile ref as stale after a successful refresh", async () => {
    if (os.platform() === "win32") {
      return;
    }
    await withTempHome("openclaw-secrets-runtime-refresh-owner-", async (home) => {
      const { secretFile, agentDir } = await createOpenAIFileRuntimeFixture(home);
      const firstRef = { source: "file" as const, provider: "default", id: "/accounts/first" };
      const secondRef = { source: "file" as const, provider: "default", id: "/accounts/second" };
      let activeRef = firstRef;
      const loadAuthStore = () =>
        loadAuthStoreWithProfiles({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: activeRef,
          },
        });
      const writeSecrets = async (includeSecond: boolean) => {
        await fs.writeFile(
          secretFile,
          `${JSON.stringify({
            providers: { openai: { apiKey: "test-api-key" } },
            accounts: {
              first: "first-fixture",
              ...(includeSecond ? { second: "second-fixture" } : {}),
            },
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      };

      await writeSecrets(true);
      const prepared = await prepareSecretsRuntimeSnapshot({
        config: createOpenAIFileRuntimeConfig(secretFile),
        agentDirs: [agentDir],
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
        loadAuthStore,
      });
      prepared.secretOwners = [
        ...(prepared.secretOwners ?? []),
        {
          ownerKind: "account",
          ownerId: "discord:ops",
          refKeys: ["env:default:DISCORD_BOT_TOKEN"],
        },
      ];
      activateSecretsRuntimeSnapshot(prepared);

      activeRef = secondRef;
      await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      expect(expectActiveSecretsRuntimeSnapshot().secretOwners).toContainEqual({
        ownerKind: "account",
        ownerId: "discord:ops",
        refKeys: ["env:default:DISCORD_BOT_TOKEN"],
      });
      await writeSecrets(false);

      const error = await refreshActiveProviderAuthRuntimeSnapshot().catch(
        (cause: unknown) => cause,
      );
      expect(listSecretResolutionErrorOwners(error)).toContainEqual(
        expect.objectContaining({
          ownerKind: "account",
          ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId: "openai:default" }),
          degradationState: "stale",
          failureMatched: true,
          source: "auth-store",
        }),
      );
    });
  });
});

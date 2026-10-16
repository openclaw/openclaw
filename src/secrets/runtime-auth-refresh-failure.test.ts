/** Tests secrets runtime refresh handling for auth-profile stores. */
import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  createConfigResolutionFacts,
  getAuthoredConfigSecretRef,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { SecretRef } from "../config/types.secrets.js";
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
import { listActiveDegradedSecretOwners } from "./runtime-degraded-state.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
} from "./runtime.js";

vi.unmock("../version.js");

const fileAuthStore = (keyRef: SecretRef = OPENAI_FILE_KEY_REF) =>
  loadAuthStoreWithProfiles({
    "openai:default": { type: "api_key", provider: "openai", keyRef },
  });
async function runtimeFixture(home: string) {
  const fixture = await createOpenAIFileRuntimeFixture(home);
  const config = createOpenAIFileRuntimeConfig(fixture.secretFile);
  return {
    ...fixture,
    config,
    prepare: (options: Partial<Parameters<typeof prepareSecretsRuntimeSnapshot>[0]> = {}) =>
      prepareSecretsRuntimeSnapshot({
        config,
        agentDirs: [fixture.agentDir],
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
        loadAuthStore: () => fileAuthStore(),
        ...options,
      }),
  };
}
async function withRuntime(
  run: (fixture: Awaited<ReturnType<typeof runtimeFixture>>) => Promise<void>,
) {
  if (os.platform() !== "win32") {
    await withTempHome("openclaw-secrets-runtime-refresh-", async (home) =>
      run(await runtimeFixture(home)),
    );
  }
}

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
    await withRuntime(async ({ config, agentDir, prepare }) => {
      let loadAuthStoreCalls = 0;
      const loadAuthStore = () => {
        loadAuthStoreCalls += 1;
        if (loadAuthStoreCalls > 1) {
          throw new Error("simulated secrets runtime refresh failure");
        }
        return fileAuthStore();
      };

      const prepared = await prepare({ loadAuthStore });

      activateSecretsRuntimeSnapshot(prepared);
      expectResolvedOpenAIRuntime(agentDir);

      await expect(
        prepare({
          config: { ...config, gateway: { auth: { mode: "token" } } },
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
    await withRuntime(async ({ secretFile, agentDir, prepare }) => {
      const firstRef = { source: "file" as const, provider: "default", id: "/accounts/first" };
      const secondRef = { source: "file" as const, provider: "default", id: "/accounts/second" };
      let activeRef = firstRef;
      const loadAuthStore = () => fileAuthStore(activeRef);
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
      const prepared = await prepare({ loadAuthStore });
      const discordTokenPath = "channels.discord.accounts.ops.token";
      const discordOwner = {
        ownerKind: "account" as const,
        ownerId: "discord:ops",
        refKeys: ["env:default:DISCORD_BOT_TOKEN"],
      };
      const discordWarning = {
        code: "SECRETS_OWNER_UNAVAILABLE" as const,
        path: discordTokenPath,
        message: "Discord account ops remains unavailable.",
      };
      setConfigResolutionFacts(
        prepared.config,
        createConfigResolutionFacts([], new Map([[discordTokenPath, "DISCORD_BOT_TOKEN"]])),
      );
      prepared.secretOwners = [...(prepared.secretOwners ?? []), discordOwner];
      prepared.degradedOwners = [
        {
          ...discordOwner,
          state: "unavailable",
          degradationState: "cold",
          paths: [discordTokenPath],
          reason: "secret reference could not be resolved",
        },
      ];
      prepared.warnings = [discordWarning];
      activateSecretsRuntimeSnapshot(prepared);

      activeRef = secondRef;
      await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      const refreshed = expectActiveSecretsRuntimeSnapshot();
      expect(getAuthoredConfigSecretRef(refreshed.config, discordTokenPath)).toEqual({
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      });
      expect(refreshed.secretOwners).toContainEqual(discordOwner);
      expect(
        refreshed.degradedOwners?.filter((owner) => owner.ownerId === "discord:ops"),
      ).toHaveLength(1);
      await writeSecrets(false);

      await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      expect(listActiveDegradedSecretOwners()).toContainEqual(
        expect.objectContaining({
          ownerKind: "account",
          ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId: "openai:default" }),
          degradationState: "stale",
        }),
      );
      expect(
        listActiveDegradedSecretOwners().filter((owner) => owner.ownerId === "discord:ops"),
      ).toHaveLength(1);
      expect(expectActiveSecretsRuntimeSnapshot().warnings).toContainEqual(discordWarning);
      const profile = expectActiveSecretsRuntimeSnapshot().authStores.find(
        (entry) => entry.agentDir === agentDir,
      )?.store.profiles["openai:default"];
      expect(profile).toMatchObject({ type: "api_key", key: "second-fixture" });
    });
  });

  it("makes an auth-profile credential cold when its provider endpoint changes", async () => {
    await withRuntime(async ({ secretFile, agentDir, prepare }) => {
      const profileId = "openai:default";
      const config = (baseUrl: string) => {
        const candidate = createOpenAIFileRuntimeConfig(secretFile);
        const openai = candidate.models?.providers?.openai;
        if (openai) {
          openai.baseUrl = baseUrl;
        }
        return candidate;
      };
      const active = await prepare({
        config: config("https://old.example.invalid/v1"),
      });
      activateSecretsRuntimeSnapshot(active);
      await fs.unlink(secretFile);

      const candidate = await prepare({
        config: config("https://new.example.invalid/v1"),
        allowUnavailableSecretOwners: true,
      });

      expect(candidate.degradedOwners).toContainEqual(
        expect.objectContaining({
          ownerKind: "account",
          ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
          degradationState: "cold",
        }),
      );
      expect(candidate.authStores[0]?.store.profiles[profileId]).toMatchObject({
        type: "api_key",
        provider: "openai",
        keyRef: OPENAI_FILE_KEY_REF,
      });
      expect(candidate.authStores[0]?.store.profiles[profileId]).not.toHaveProperty("key");
    });
  });
});

/** Tests inline secret refs discovered from runtime auth stores. */
import { describe, expect, it } from "vitest";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import { activateSecretsRuntimeSnapshot } from "./runtime.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const defaultAgentDir = "/tmp/openclaw-agent-main";
function prepareProfiles(
  profiles: Parameters<typeof loadAuthStoreWithProfiles>[0],
  options: Partial<Parameters<typeof prepareSecretsRuntimeSnapshot>[0]> = {},
) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig({ models: {}, secrets: {} }),
    env: {},
    agentDirs: [defaultAgentDir],
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    loadAuthStore: () => loadAuthStoreWithProfiles(profiles),
    ...options,
  });
}
async function expectInlineRef(field: "key" | "token") {
  const ref = envRef(field === "key" ? "MY_KEY" : "MY_TOKEN");
  const value = `resolved-${field}-value`;
  const profileId = `custom:inline-${field}`;
  const profile =
    field === "key"
      ? { type: "api_key" as const, provider: "custom", key: ref as unknown as string }
      : { type: "token" as const, provider: "custom", token: ref as unknown as string };
  const snapshot = await prepareProfiles(
    { [profileId]: profile },
    {
      env: { [ref.id]: value },
      allowUnavailableSecretOwners: false,
    },
  );
  const resolved = snapshot.authStores[0]?.store.profiles[profileId] as Record<string, unknown>;
  expect(resolved[`${field}Ref`]).toEqual(ref);
  activateSecretsRuntimeSnapshot(snapshot);
  expect(resolved[field]).toBe(value);
}
function expectWarning(
  warnings: unknown,
  code: string,
  profileId: string,
  field = "key",
  dir = defaultAgentDir,
) {
  expect(warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code, path: `${dir}.auth-profiles.${profileId}.${field}` }),
    ]),
  );
}
function expectRefOnly(profile: unknown, provider: string, ref: unknown, field = "key") {
  expect(profile).toMatchObject({
    type: field === "key" ? "api_key" : "token",
    provider,
    [`${field}Ref`]: ref,
  });
  expect(profile).not.toHaveProperty(field);
}
const keyProfile = (provider: string, id: string) => ({
  type: "api_key" as const,
  provider,
  keyRef: envRef(id),
});

describe("secrets runtime snapshot inline auth-store refs", () => {
  it("normalizes inline SecretRef object on token to tokenRef", async () => {
    await expectInlineRef("token");
  });

  it("normalizes inline SecretRef object on key to keyRef", async () => {
    await expectInlineRef("key");
  });

  it("skips refs on auth profiles that are not eligible for their configured provider", async () => {
    const profileId = "openai:mismatched";
    const tokenProfileId = "github-copilot:mismatched";
    const snapshot = await prepareProfiles(
      {
        [profileId]: { ...keyProfile("openai", "MISSING_MISMATCHED_KEY"), key: "unused" },
        [tokenProfileId]: {
          type: "token",
          provider: "github-copilot",
          token: "unused",
          tokenRef: envRef("MISSING_MISMATCHED_TOKEN"),
        },
      },
      {
        config: asConfig({
          auth: {
            profiles: {
              [profileId]: { provider: "anthropic", mode: "api_key" },
              [tokenProfileId]: { provider: "anthropic", mode: "token" },
            },
          },
        }),
      },
    );

    expect(snapshot.degradedOwners).toEqual([]);
    const code = "SECRETS_REF_IGNORED_INACTIVE_SURFACE";
    expectWarning(snapshot.warnings, code, profileId);
    expectWarning(snapshot.warnings, code, tokenProfileId, "token");
    const profiles = snapshot.authStores[0]?.store.profiles;
    expectRefOnly(profiles?.[profileId], "openai", envRef("MISSING_MISMATCHED_KEY"));
    expectRefOnly(
      profiles?.[tokenProfileId],
      "github-copilot",
      envRef("MISSING_MISMATCHED_TOKEN"),
      "token",
    );
  });

  it("isolates a failed profile ref while materializing an eligible sibling profile", async () => {
    const agentDir = "/tmp/openclaw-agent-profile-isolation";
    const coldProfileId = "openai:cold";
    const healthyProfileId = "anthropic:healthy";
    const snapshot = await prepareProfiles(
      {
        [coldProfileId]: keyProfile("openai", "MISSING_OPENAI_PROFILE_KEY"),
        [healthyProfileId]: keyProfile("anthropic", "ANTHROPIC_PROFILE_KEY"),
      },
      {
        config: asConfig({}),
        env: { ANTHROPIC_PROFILE_KEY: "anthropic-runtime-key" },
        agentDirs: [agentDir],
      },
    );

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "account",
        ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId: coldProfileId }),
        state: "unavailable",
        degradationState: "cold",
      },
    ]);
    const profiles = snapshot.authStores[0]?.store.profiles;
    expectRefOnly(profiles?.[coldProfileId], "openai", envRef("MISSING_OPENAI_PROFILE_KEY"));
    expect(profiles?.[healthyProfileId]).toMatchObject({ key: "anthropic-runtime-key" });
  });

  it("isolates an auth profile whose SecretRef provider is absent from copied config", async () => {
    const agentDir = "/tmp/openclaw-agent-copied-auth-store";
    const profileId = "openai:copied";
    const keyRef = { source: "file" as const, provider: "clawrouter_key", id: "value" };
    const snapshot = await prepareProfiles(
      {
        [profileId]: { type: "api_key", provider: "openai", keyRef },
      },
      {
        config: asConfig({
          auth: { order: { openai: [profileId] } },
        }),
        agentDirs: [agentDir],
      },
    );

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "account",
        ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
        state: "unavailable",
        reason: "secret provider is not configured",
      },
    ]);
    expectWarning(snapshot.warnings, "SECRETS_OWNER_UNAVAILABLE", profileId, "key", agentDir);
    expectRefOnly(snapshot.authStores[0]?.store.profiles[profileId], "openai", keyRef);
  });
});

import { expect, it } from "vitest";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import { activateSecretsRuntimeSnapshot } from "./runtime.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const envRef = (id = "KEY") => ({ source: "env" as const, provider: "default", id });
const agentDir = "/tmp/openclaw-agent-main";
function prepare(
  profiles: Parameters<typeof loadAuthStoreWithProfiles>[0],
  options: Partial<Parameters<typeof prepareSecretsRuntimeSnapshot>[0]> = {},
) {
  return prepareSecretsRuntimeSnapshot({
    config: {},
    env: {},
    agentDirs: [agentDir],
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: new Map(),
    loadAuthStore: () => loadAuthStoreWithProfiles(profiles),
    ...options,
  });
}
function expectWarning(warnings: unknown, code: string, id: string, field = "key") {
  expect(warnings).toContainEqual(
    expect.objectContaining({ code, path: `${agentDir}.auth-profiles.${id}.${field}` }),
  );
}
function expectRefOnly(profile: unknown, ref: unknown, field = "key") {
  expect(profile).toMatchObject({ [`${field}Ref`]: ref });
  expect(profile).not.toHaveProperty(field);
}

it.each([
  ["key", false],
  ["token", false],
  ["key", true],
  ["token", true],
] as const)("normalizes %s refs and fences ineligible=%s profiles", async (field, ineligible) => {
  const provider = ineligible ? (field === "key" ? "openai" : "github-copilot") : "custom";
  const id = `${provider}:fixture`;
  const ref = envRef();
  const input = ineligible ? "unused" : (ref as unknown as string);
  const profile =
    field === "key"
      ? { type: "api_key" as const, provider, key: input, ...(ineligible ? { keyRef: ref } : {}) }
      : {
          type: "token" as const,
          provider,
          token: input,
          ...(ineligible ? { tokenRef: ref } : {}),
        };
  const config = ineligible
    ? asConfig({
        auth: {
          profiles: {
            [id]: { provider: "anthropic", mode: field === "key" ? "api_key" : "token" },
          },
        },
      })
    : {};
  const snapshot = await prepare(
    { [id]: profile },
    { config, env: { KEY: "resolved" }, allowUnavailableSecretOwners: ineligible },
  );
  const resolved = snapshot.authStores[0]?.store.profiles[id];
  if (ineligible) {
    expect(snapshot.degradedOwners).toEqual([]);
    expectWarning(snapshot.warnings, "SECRETS_REF_IGNORED_INACTIVE_SURFACE", id, field);
    expectRefOnly(resolved, ref, field);
  } else {
    expect(resolved).toHaveProperty(`${field}Ref`, ref);
    activateSecretsRuntimeSnapshot(snapshot);
    expect(resolved).toHaveProperty(field, "resolved");
  }
});

it.each(["missing value", "unconfigured provider"])(
  "isolates a profile with %s",
  async (failure) => {
    const id = "openai:cold";
    const keyRef =
      failure === "missing value"
        ? envRef("MISSING")
        : { source: "file" as const, provider: "clawrouter_key", id: "value" };
    const snapshot = await prepare(
      {
        [id]: { type: "api_key", provider: "openai", keyRef },
        healthy: { type: "api_key", provider: "anthropic", keyRef: envRef() },
      },
      { config: asConfig({ auth: { order: { openai: [id] } } }), env: { KEY: "healthy" } },
    );
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "account",
        ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId: id }),
        state: "unavailable",
        degradationState: "cold",
      },
    ]);
    expectRefOnly(snapshot.authStores[0]?.store.profiles[id], keyRef);
    expect(snapshot.authStores[0]?.store.profiles.healthy).toMatchObject({ key: "healthy" });
    if (failure === "unconfigured provider") {
      expect(snapshot.degradedOwners?.[0]?.reason).toBe("secret provider is not configured");
      expectWarning(snapshot.warnings, "SECRETS_OWNER_UNAVAILABLE", id);
    }
  },
);

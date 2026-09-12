/**
 * Tier 2 real-flow tests for issue #145740.
 *
 * These drive the production secrets preparation path without injecting
 * `loadAuthStore`: the auth-profile store is persisted with the real SQLite
 * writer and re-read through the production `loadAuthProfileStoreForSecretsRuntime`
 * loader under the agent-dir owner scope, so credential loading is the same
 * shared/agent-local machinery the CLI uses (see `agent-exec`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withAuthProfileStoreAgentDir } from "../agents/auth-profiles.js";
import { writePersistedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import type { ApiKeyCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareSecretsRuntimeSnapshot } from "./runtime.js";
import { readSecretStoreValue, writeSecretStoreEntry } from "./store/secret-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const NVIDIA_STORE_REF = { source: "store", provider: "default", id: "NVIDIA_API_KEY" } as const;
const OPENAI_ENV_REF = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("auth-profile store ref resolution (issue #145740)", () => {
  it("does not resolve an unrelated auth.order-excluded profile (no SECRET_REF_NOT_FOUND)", async () => {
    const ownerStateDir = tempDirs.make("t2-owner-state-");
    const tempStateDir = tempDirs.make("t2-temp-state-");
    const mainAgentDir = tempDirs.make("t2-agent-");

    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      value: "nvidia-secret",
      kind: "secret",
      updatedBy: "test",
      database: { env: { OPENCLAW_STATE_DIR: ownerStateDir } },
    });

    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "nvidia:test": {
            type: "api_key",
            provider: "nvidia",
            keyRef: { ...NVIDIA_STORE_REF },
          },
          "openai:test": {
            type: "api_key",
            provider: "openai",
            keyRef: { ...OPENAI_ENV_REF },
          },
        },
      },
      mainAgentDir,
    );

    const config = asConfig({
      auth: { order: { nvidia: [] } },
    });

    const snapshot = await withAuthProfileStoreAgentDir(mainAgentDir, ownerStateDir, async () => {
      return prepareSecretsRuntimeSnapshot({
        config,
        env: { OPENCLAW_STATE_DIR: tempStateDir, OPENAI_API_KEY: "openai-key" },
        agentDirs: [mainAgentDir],
        includeConfigRefs: false,
      });
    });

    const openaiProfile = snapshot.authStores
      .map((entry) => entry.store.profiles["openai:test"])
      .find(
        (profile): profile is ApiKeyCredential =>
          profile?.type === "api_key" && profile.key === "openai-key",
      );
    expect(openaiProfile?.key).toBe("openai-key");

    const nvidiaProfile = snapshot.authStores
      .map((entry) => entry.store.profiles["nvidia:test"])
      .find((profile): profile is ApiKeyCredential => profile?.type === "api_key");
    expect(nvidiaProfile?.key).toBeUndefined();
  });

  it("resolves a selected profile store ref through the owner env, leaving the temp DB unchanged", async () => {
    const ownerStateDir = tempDirs.make("t3-owner-state-");
    const tempStateDir = tempDirs.make("t3-temp-state-");
    const mainAgentDir = tempDirs.make("t3-agent-");

    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      value: "nvidia-secret",
      kind: "secret",
      updatedBy: "test",
      database: { env: { OPENCLAW_STATE_DIR: ownerStateDir } },
    });

    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "nvidia:test": {
            type: "api_key",
            provider: "nvidia",
            keyRef: { ...NVIDIA_STORE_REF },
          },
        },
      },
      mainAgentDir,
    );

    const tempRead = readSecretStoreValue({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      database: { env: { OPENCLAW_STATE_DIR: tempStateDir } },
    });
    expect(tempRead.ok).toBe(false);

    const config = asConfig({
      auth: { order: { nvidia: ["nvidia:test"] } },
    });

    const snapshot = await withAuthProfileStoreAgentDir(mainAgentDir, ownerStateDir, async () => {
      return prepareSecretsRuntimeSnapshot({
        config,
        env: { OPENCLAW_STATE_DIR: tempStateDir },
        agentDirs: [mainAgentDir],
        includeConfigRefs: false,
      });
    });

    const nvidiaProfile = snapshot.authStores
      .map((entry) => entry.store.profiles["nvidia:test"])
      .find(
        (profile): profile is ApiKeyCredential =>
          profile?.type === "api_key" && profile.key === "nvidia-secret",
      );
    expect(nvidiaProfile?.key).toBe("nvidia-secret");

    const tempReadAfter = readSecretStoreValue({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      database: { env: { OPENCLAW_STATE_DIR: tempStateDir } },
    });
    expect(tempReadAfter.ok).toBe(false);
  });

  it("keeps a session-pinned, order-excluded SecretRef profile materialized (pin exemption)", async () => {
    const ownerStateDir = tempDirs.make("t9-owner-state-");
    const tempStateDir = tempDirs.make("t9-temp-state-");
    const mainAgentDir = tempDirs.make("t9-agent-");

    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      value: "nvidia-secret",
      kind: "secret",
      updatedBy: "test",
      database: { env: { OPENCLAW_STATE_DIR: ownerStateDir } },
    });

    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "nvidia:test": {
            type: "api_key",
            provider: "nvidia",
            keyRef: { ...NVIDIA_STORE_REF },
          },
        },
      },
      mainAgentDir,
    );

    // The session pins "nvidia:test" even though auth.order.nvidia is empty.
    const config = asConfig({
      auth: { order: { nvidia: [] } },
    });

    const snapshot = await withAuthProfileStoreAgentDir(mainAgentDir, ownerStateDir, async () => {
      return prepareSecretsRuntimeSnapshot({
        config,
        env: { OPENCLAW_STATE_DIR: tempStateDir },
        agentDirs: [mainAgentDir],
        includeConfigRefs: false,
        pinnedProfileId: "nvidia:test",
      });
    });

    const nvidiaProfile = snapshot.authStores
      .map((entry) => entry.store.profiles["nvidia:test"])
      .find(
        (profile): profile is ApiKeyCredential =>
          profile?.type === "api_key" && profile.key === "nvidia-secret",
      );
    // The pinned profile must survive the empty order and resolve through owner env.
    expect(nvidiaProfile?.key).toBe("nvidia-secret");

    const tempReadAfter = readSecretStoreValue({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      database: { env: { OPENCLAW_STATE_DIR: tempStateDir } },
    });
    expect(tempReadAfter.ok).toBe(false);
  });

  it("recovers surviving profiles when a stored order lists only missing credentials", async () => {
    const ownerStateDir = tempDirs.make("t10-owner-state-");
    const tempStateDir = tempDirs.make("t10-temp-state-");
    const mainAgentDir = tempDirs.make("t10-agent-");

    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      value: "nvidia-secret",
      kind: "secret",
      updatedBy: "test",
      database: { env: { OPENCLAW_STATE_DIR: ownerStateDir } },
    });

    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        order: { nvidia: ["nvidia:missing"] },
        profiles: {
          "nvidia:test": {
            type: "api_key",
            provider: "nvidia",
            keyRef: { ...NVIDIA_STORE_REF },
          },
        },
      },
      mainAgentDir,
    );

    // The stored order lists a missing credential; recovery keeps the surviving
    // compatible profile so its store ref must still materialize.
    const config = asConfig({
      auth: { order: { nvidia: ["nvidia:missing"] } },
    });

    const snapshot = await withAuthProfileStoreAgentDir(mainAgentDir, ownerStateDir, async () => {
      return prepareSecretsRuntimeSnapshot({
        config,
        env: { OPENCLAW_STATE_DIR: tempStateDir },
        agentDirs: [mainAgentDir],
        includeConfigRefs: false,
      });
    });

    const nvidiaProfile = snapshot.authStores
      .map((entry) => entry.store.profiles["nvidia:test"])
      .find(
        (profile): profile is ApiKeyCredential =>
          profile?.type === "api_key" && profile.key === "nvidia-secret",
      );
    expect(nvidiaProfile?.key).toBe("nvidia-secret");
  });

  it("keeps a split-provider bound profile effective despite empty auth.order", async () => {
    const ownerStateDir = tempDirs.make("t11-owner-state-");
    const tempStateDir = tempDirs.make("t11-temp-state-");
    const mainAgentDir = tempDirs.make("t11-agent-");

    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "OR_KEY_B",
      value: "or-key-b-secret",
      kind: "secret",
      updatedBy: "test",
      database: { env: { OPENCLAW_STATE_DIR: ownerStateDir } },
    });

    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openrouter:key-b": {
            type: "api_key",
            provider: "openrouter",
            keyRef: { source: "store", provider: "default", id: "OR_KEY_B" },
          },
        },
      },
      mainAgentDir,
    );

    const config = asConfig({
      auth: { order: { openrouter: [] } },
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: { source: "env", provider: "default", id: "OPENROUTER_API_KEY" },
            models: [],
          },
          "openrouter-minimax": {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "openrouter:key-b",
            models: [],
          },
        },
      },
    });

    const snapshot = await withAuthProfileStoreAgentDir(mainAgentDir, ownerStateDir, async () => {
      return prepareSecretsRuntimeSnapshot({
        config,
        env: { OPENCLAW_STATE_DIR: tempStateDir, OPENROUTER_API_KEY: "openrouter-key" },
        agentDirs: [mainAgentDir],
        includeConfigRefs: false,
      });
    });

    // key-b is referenced by the openrouter-minimax entry (matching endpoint), so
    // it stays config-bound and materialized even though auth.order.openrouter is empty.
    const boundProfile = snapshot.authStores
      .map((entry) => entry.store.profiles["openrouter:key-b"])
      .find(
        (profile): profile is ApiKeyCredential =>
          profile?.type === "api_key" && profile.key === "or-key-b-secret",
      );
    expect(boundProfile?.key).toBe("or-key-b-secret");
  });

  it("keeps a configured-model binding profile materialized and resolves through owner env", async () => {
    const ownerStateDir = tempDirs.make("t12-owner-state-");
    const tempStateDir = tempDirs.make("t12-temp-state-");
    const mainAgentDir = tempDirs.make("t12-agent-");

    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "ANTHROPIC_KEY",
      value: "anthropic-secret",
      kind: "secret",
      updatedBy: "test",
      database: { env: { OPENCLAW_STATE_DIR: ownerStateDir } },
    });

    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "anthropic:verified": {
            type: "api_key",
            provider: "anthropic",
            keyRef: { source: "store", provider: "default", id: "ANTHROPIC_KEY" },
          },
        },
      },
      mainAgentDir,
    );

    // The configured default model is bound to "anthropic:verified" even though
    // auth.order.anthropic is empty. The standalone prepare gate passes it as an
    // extra config-bound profile so it stays materialized.
    const config = asConfig({
      auth: { order: { anthropic: [] } },
    });

    const snapshot = await withAuthProfileStoreAgentDir(mainAgentDir, ownerStateDir, async () => {
      return prepareSecretsRuntimeSnapshot({
        config,
        env: { OPENCLAW_STATE_DIR: tempStateDir },
        agentDirs: [mainAgentDir],
        includeConfigRefs: false,
        configBoundProfileIds: new Set(["anthropic:verified"]),
      });
    });

    const boundProfile = snapshot.authStores
      .map((entry) => entry.store.profiles["anthropic:verified"])
      .find(
        (profile): profile is ApiKeyCredential =>
          profile?.type === "api_key" && profile.key === "anthropic-secret",
      );
    // The configured-model binding must survive the empty order and resolve
    // through the shared owner env without copying into the temporary state DB.
    expect(boundProfile?.key).toBe("anthropic-secret");

    const tempReadAfter = readSecretStoreValue({
      scope: { kind: "team" },
      name: "ANTHROPIC_KEY",
      database: { env: { OPENCLAW_STATE_DIR: tempStateDir } },
    });
    expect(tempReadAfter.ok).toBe(false);
  });
});

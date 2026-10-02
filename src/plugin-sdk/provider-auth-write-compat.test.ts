import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  upsertAuthProfileWithLock as upsertApiKeyProfileWithLock,
  upsertAuthProfileWithLockOrThrow,
} from "./provider-auth-api-key.js";
import {
  removeProviderAuthProfilesWithLock,
  updateAuthProfileStoreWithLock,
  upsertAuthProfileWithLock,
} from "./provider-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("provider auth write compatibility", () => {
  it("keeps the shipped write parameter contracts on both SDK subpaths", () => {
    type ShippedFields = "profileId" | "credential" | "agentDir" | "stateDir";
    expectTypeOf<
      keyof Parameters<typeof upsertAuthProfileWithLock>[0]
    >().toEqualTypeOf<ShippedFields>();
    expectTypeOf<
      keyof Parameters<typeof upsertApiKeyProfileWithLock>[0]
    >().toEqualTypeOf<ShippedFields>();
    expectTypeOf<
      keyof Parameters<typeof upsertAuthProfileWithLockOrThrow>[0]
    >().toEqualTypeOf<ShippedFields>();
    expectTypeOf<
      Parameters<Parameters<typeof updateAuthProfileStoreWithLock>[0]["updater"]>
    >().toEqualTypeOf<[AuthProfileStore]>();
  });

  it("passes only the auth store to the public updater callback", async () => {
    const root = tempDirs.make("openclaw-provider-auth-callback-");
    const agentDir = path.join(root, "agents", "work", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const legacy: AuthProfileStore = { version: 1, profiles: {} };
    Object.assign(legacy.profiles, {
      "sample:saved": {
        type: "token",
        provider: "sample",
        tokenRef: { source: "env", id: "SYNTHETIC_SAVED_TOKEN" },
      },
    });
    saveAuthProfileStore(legacy, agentDir);
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["sample:saved"]).toEqual({
      type: "token",
      provider: "sample",
      tokenRef: { source: "env", provider: "default", id: "SYNTHETIC_SAVED_TOKEN" },
    });
    const updater = vi.fn((store: AuthProfileStore) => {
      store.profiles["sample:new"] = { type: "api_key", provider: "sample", key: "synthetic-key" };
      Object.assign(store.profiles, {
        "sample:ref": {
          type: "api_key",
          provider: "sample",
          keyRef: { source: "env", id: "SYNTHETIC_AUTH_KEY" },
        },
        "sample:token": {
          type: "token",
          provider: "sample",
          tokenRef: { source: "env", id: "SYNTHETIC_AUTH_TOKEN" },
        },
      });
      return true;
    });
    const updated = await updateAuthProfileStoreWithLock({ agentDir, updater });
    expect(updater).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ version: 1, profiles: expect.any(Object) }),
    );
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["sample:new"]).toEqual({
      type: "api_key",
      provider: "sample",
      key: "synthetic-key",
    });
    for (const store of [updated, loadPersistedAuthProfileStore(agentDir)]) {
      expect(store?.profiles["sample:ref"]).toEqual({
        type: "api_key",
        provider: "sample",
        keyRef: { source: "env", provider: "default", id: "SYNTHETIC_AUTH_KEY" },
      });
      expect(store?.profiles["sample:token"]).toEqual({
        type: "token",
        provider: "sample",
        tokenRef: { source: "env", provider: "default", id: "SYNTHETIC_AUTH_TOKEN" },
      });
    }
  });

  it.each([
    { name: "provider-auth", upsert: upsertAuthProfileWithLock },
    { name: "throwing provider-auth-api-key", upsert: upsertAuthProfileWithLockOrThrow },
  ])("ignores internal write controls through $name", async ({ upsert }) => {
    const root = tempDirs.make("openclaw-provider-auth-sdk-");
    const agentDir = path.join(root, "agents", "work", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "sample:existing": {
            type: "api_key",
            provider: "sample",
            key: "old-key",
            displayName: "Old account",
          },
        },
      },
      agentDir,
    );
    const params = {
      agentDir,
      profileId: "sample:existing",
      credential: { type: "api_key" as const, provider: "sample", key: "new-key" },
      preserveApiKeyMetadata: true,
      validateCurrentCredential: () => {
        throw new Error("Internal callback must not control plugin writes");
      },
    };

    await upsert(params);

    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["sample:existing"]).toEqual({
      type: "api_key",
      provider: "sample",
      key: "new-key",
    });
  });

  it("preserves nullable failures on both shipped Plugin SDK subpaths", async () => {
    const root = tempDirs.make("openclaw-provider-auth-sdk-");
    const agentDir = path.join(root, "agents", "work", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:existing": { type: "api_key", provider: "openai", key: "sk-existing" },
        },
      },
      agentDir,
    );
    openOpenClawAgentDatabase({
      agentId: "work",
      path: resolveAuthProfileDatabasePath(agentDir),
    }).db.exec("ALTER TABLE auth_profile_store DROP COLUMN updated_at");

    await expect(
      updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          store.profiles["openai:existing"] = {
            type: "api_key",
            provider: "openai",
            key: "sk-updated",
          };
          return true;
        },
      }),
    ).resolves.toBeNull();
    await expect(
      removeProviderAuthProfilesWithLock({
        agentDir,
        provider: "openai",
      }),
    ).resolves.toBeNull();
    await expect(
      upsertApiKeyProfileWithLock({
        agentDir,
        profileId: "openai:new",
        credential: { type: "api_key", provider: "openai", key: "sk-new" },
      }),
    ).resolves.toBeNull();
  });
});

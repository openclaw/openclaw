import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, describe, expect, expectTypeOf, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import {
  resolveAuthProfileDatabasePath,
  readPersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStateRaw,
} from "../agents/auth-profiles/sqlite.js";
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
  clearRuntimeAuthProfileStoreSnapshots();
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
    type ShippedUpdateFields =
      | "agentDir"
      | "profileId"
      | "sharedStoreWrite"
      | "stateDir"
      | "saveOptions"
      | "updater";
    expectTypeOf<
      keyof Parameters<typeof updateAuthProfileStoreWithLock>[0]
    >().toEqualTypeOf<ShippedUpdateFields>();
    expectTypeOf<
      Parameters<Parameters<typeof updateAuthProfileStoreWithLock>[0]["updater"]>
    >().toEqualTypeOf<[AuthProfileStore]>();
  });

  it("preserves SDK callback inputs and refuses lossy SecretRef writes", async () => {
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
    const assertCurrent = vi.fn(() => {
      throw new Error("Internal callback must not control plugin writes");
    });
    const params = { agentDir, updater, assertCurrent };
    const updated = await updateAuthProfileStoreWithLock(params);
    expect(assertCurrent).not.toHaveBeenCalled();
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
    const admitted = loadPersistedAuthProfileStore(agentDir);
    assert(admitted);
    setRuntimeAuthProfileStoreSnapshot(admitted, agentDir);
    const persistedBefore = structuredClone(readPersistedAuthProfileStoreRaw(agentDir));
    const stateBefore = structuredClone(readPersistedAuthProfileStateRaw(agentDir));
    const snapshotBefore = structuredClone(getRuntimeAuthProfileStoreSnapshotCore(agentDir));
    assert(snapshotBefore);
    for (const refField of ["keyRef", "tokenRef"] as const) {
      const input = structuredClone(admitted);
      Object.assign(input.profiles, {
        "sample:unsupported": {
          type: refField === "keyRef" ? "api_key" : "token",
          provider: "sample",
          [refField]: { source: "env", id: "SYNTHETIC_EXTENDED_REF", opaque: { keep: true } },
        },
      });
      const originalInput = structuredClone(input);
      expect(() => saveAuthProfileStore(input, agentDir)).toThrow(
        "explicitly call coerceSecretRef",
      );
      await expect(
        updateAuthProfileStoreWithLock({
          agentDir,
          updater(store) {
            Object.assign(store.profiles, input.profiles);
            return true;
          },
        }),
      ).resolves.toBeNull();
      expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(persistedBefore);
      expect(readPersistedAuthProfileStateRaw(agentDir)).toEqual(stateBefore);
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toEqual(snapshotBefore);
      expect(input).toEqual(originalInput);
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

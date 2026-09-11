import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
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
  it("keeps the shipped upsert parameter fields on both SDK subpaths", () => {
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
  });

  it.each([
    { name: "provider-auth", upsert: upsertAuthProfileWithLock },
    { name: "provider-auth-api-key", upsert: upsertApiKeyProfileWithLock },
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

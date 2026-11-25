import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, expect, expectTypeOf, it, vi } from "vitest";
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
import { saveAuthProfileStore as saveStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  upsertAuthProfileWithLock as upsertApiKey,
  upsertAuthProfileWithLockOrThrow as upsertOrThrow,
} from "./provider-auth-api-key.js";
import {
  removeProviderAuthProfilesWithLock as removeProfiles,
  updateAuthProfileStoreWithLock as update,
  upsertAuthProfileWithLock as upsert,
} from "./provider-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
});

function makeAgentDir(profiles?: AuthProfileStore["profiles"]) {
  const agentDir = path.join(tempDirs.make("auth-sdk-"), "agents", "work", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  if (profiles) {
    saveStore({ version: 1, profiles }, agentDir);
  }
  return agentDir;
}

function readState(dir: string) {
  return {
    persisted: readPersistedAuthProfileStoreRaw(dir),
    state: readPersistedAuthProfileStateRaw(dir),
    snapshot: getRuntimeAuthProfileStoreSnapshotCore(dir),
  };
}
const profiles = (dir: string) => loadPersistedAuthProfileStore(dir)?.profiles;
const apiKey = (key: string, provider = "sample") => ({ type: "api_key" as const, provider, key });
const envRef = (id: string, normalized = false) => ({
  source: "env" as const,
  ...(normalized ? { provider: "default" } : {}),
  id,
});

const mergeProfiles = (values: Record<string, unknown>) => (store: AuthProfileStore) => {
  Object.assign(store.profiles, values);
  return true;
};

function rejectInternalWrite() {
  throw new Error("Internal callback must not control plugin writes");
}

function refProfile(field: "keyRef" | "tokenRef", id: string, normalized = false) {
  return {
    type: field === "keyRef" ? "api_key" : "token",
    provider: "sample",
    [field]: envRef(id, normalized),
  };
}

it("keeps the shipped write parameter contracts on both SDK subpaths", () => {
  type ShippedFields = "profileId" | "credential" | "agentDir" | "stateDir";
  expectTypeOf<keyof Parameters<typeof upsert>[0]>().toEqualTypeOf<ShippedFields>();
  expectTypeOf<keyof Parameters<typeof upsertApiKey>[0]>().toEqualTypeOf<ShippedFields>();
  expectTypeOf<keyof Parameters<typeof upsertOrThrow>[0]>().toEqualTypeOf<ShippedFields>();
  type ShippedUpdateFields =
    | "agentDir"
    | "profileId"
    | "sharedStoreWrite"
    | "stateDir"
    | "saveOptions"
    | "updater";
  expectTypeOf<keyof Parameters<typeof update>[0]>().toEqualTypeOf<ShippedUpdateFields>();
  type Updater = Parameters<typeof update>[0]["updater"];
  expectTypeOf<Parameters<Updater>>().toEqualTypeOf<[AuthProfileStore]>();
});

it("preserves SDK callback inputs and refuses lossy SecretRef writes", async () => {
  const agentDir = makeAgentDir();
  const legacy: AuthProfileStore = { version: 1, profiles: {} };
  Object.assign(legacy.profiles, { "sample:saved": refProfile("tokenRef", "SAVED_TOKEN") });
  saveStore(legacy, agentDir);
  expect(profiles(agentDir)?.["sample:saved"]).toEqual(refProfile("tokenRef", "SAVED_TOKEN", true));
  const updater = vi.fn(
    mergeProfiles({
      "sample:new": apiKey("synthetic-key"),
      "sample:ref": refProfile("keyRef", "AUTH_KEY"),
      "sample:token": refProfile("tokenRef", "AUTH_TOKEN"),
    }),
  );
  const assertCurrent = vi.fn(rejectInternalWrite);
  const params = { agentDir, updater, assertCurrent };
  const updated = await update(params);
  expect(assertCurrent).not.toHaveBeenCalled();
  expect(updater).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ version: 1, profiles: expect.any(Object) }),
  );
  expect(profiles(agentDir)?.["sample:new"]).toEqual(apiKey("synthetic-key"));
  for (const store of [updated, loadPersistedAuthProfileStore(agentDir)]) {
    expect(store?.profiles["sample:ref"]).toEqual(refProfile("keyRef", "AUTH_KEY", true));
    expect(store?.profiles["sample:token"]).toEqual(refProfile("tokenRef", "AUTH_TOKEN", true));
  }
  const admitted = loadPersistedAuthProfileStore(agentDir);
  assert(admitted);
  setRuntimeAuthProfileStoreSnapshot(admitted, agentDir);
  const before = structuredClone(readState(agentDir));
  assert(before.snapshot);
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
    expect(() => saveStore(input, agentDir)).toThrow("explicitly call coerceSecretRef");
    await expect(
      update({
        agentDir,
        updater: mergeProfiles(input.profiles),
      }),
    ).resolves.toBeNull();
    expect(readState(agentDir)).toEqual(before);
    expect(input).toEqual(originalInput);
  }
});

it.each([
  { name: "provider-auth", upsert },
  { name: "throwing provider-auth-api-key", upsert: upsertOrThrow },
])("ignores internal write controls through $name", async ({ upsert: write }) => {
  const agentDir = makeAgentDir({
    "sample:existing": { ...apiKey("old-key"), displayName: "Old account" },
  });
  const params = {
    agentDir,
    profileId: "sample:existing",
    credential: apiKey("new-key"),
    preserveApiKeyMetadata: true,
    validateCurrentCredential: rejectInternalWrite,
  };

  await write(params);
  expect(profiles(agentDir)?.["sample:existing"]).toEqual(apiKey("new-key"));
});

it("preserves nullable failures on both shipped Plugin SDK subpaths", async () => {
  const agentDir = makeAgentDir({ "openai:existing": apiKey("sk-existing", "openai") });
  openOpenClawAgentDatabase({
    agentId: "work",
    path: resolveAuthProfileDatabasePath(agentDir),
  }).db.exec("ALTER TABLE auth_profile_store DROP COLUMN updated_at");

  await expect(
    update({
      agentDir,
      updater: mergeProfiles({ "openai:existing": apiKey("sk-updated", "openai") }),
    }),
  ).resolves.toBeNull();
  await expect(removeProfiles({ agentDir, provider: "openai" })).resolves.toBeNull();
  await expect(
    upsertApiKey({ agentDir, profileId: "openai:new", credential: apiKey("sk-new", "openai") }),
  ).resolves.toBeNull();
});

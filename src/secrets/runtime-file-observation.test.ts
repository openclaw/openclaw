import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { refreshAuthProfileFileState } from "../agents/auth-profiles/file-state.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotCore as getRuntimeStore,
  refreshRuntimeAuthProfileStoreSources,
  registerRuntimeAuthProfileStoreMutationListener,
  setRuntimeAuthProfileStoreSnapshot as setRuntimeStore,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreForRuntimeAsync as loadRuntimeStore,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { acquireStateDatabaseSchemaLease } from "../infra/gateway-state-owner.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { prepareSecretsRuntimeFastPathSnapshot } from "./runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
} from "./runtime.js";

const observations = vi.hoisted(() => new Map<string, Set<(filename?: string) => void>>());
// These cases exercise Gateway publication even when Vitest hosts them in a worker thread.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));
// mock-isolation: Native delivery is covered by its owner; this file proves credential publication.
vi.mock("../infra/owned-directory-observation.js", () => ({
  observeOwnedDirectory(directory: string, notify: (filename?: string) => void) {
    const callbacks = observations.get(directory) ?? new Set<(filename?: string) => void>();
    observations.set(directory, callbacks);
    callbacks.add(notify);
    return { close: () => callbacks.delete(notify) };
  },
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
const mutationSubscriptions: Array<() => void> = [];
function withSchemaLease<T>(run: () => T): T {
  const lease = acquireStateDatabaseSchemaLease(resolveOpenClawStateSqlitePath());
  try {
    return lease.run(run);
  } finally {
    lease.release();
  }
}
function saveOwnedAuthProfiles(store: AuthProfileStore, agentDir: string) {
  withSchemaLease(() =>
    saveAuthProfileStore(store, agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    }),
  );
}
function fixture() {
  const root = temporary.make("auth-observation-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  return { root, agentDir: path.join(root, "agents", "main", "agent") };
}
function profileStore(key: string, ref = false): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      example: {
        type: "api_key",
        provider: "openai",
        ...(ref
          ? { keyRef: { source: "env", provider: "default", id: "OPENCLAW_TEST_AUTH_KEY" } }
          : { key }),
      },
    },
  };
}
const readOptions = { readOnly: true, externalCli: { mode: "none" as const } };

afterEach(async () => {
  for (const unsubscribe of mutationSubscriptions.splice(0)) {
    unsubscribe();
  }
  clearSecretsRuntimeSnapshot();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it("preserves auth facts through first-file session admission after empty startup", async () => {
  const { agentDir } = fixture();
  await prepareSharedAuthStoreOwnership();
  const prepared = prepareSecretsRuntimeFastPathSnapshot({
    config: { agents: { entries: { main: { agentDir } } }, plugins: { enabled: false } },
  });
  expect(prepared).not.toBeNull();
  activateSecretsRuntimeSnapshot(prepared!.snapshot);
  const snapshot = getRuntimeStore(agentDir);
  const revision = getRuntimeAuthProfileStoreCredentialsRevision();
  withSchemaLease(() =>
    openOpenClawAgentDatabase({ agentId: "main", path: resolveAuthProfileDatabasePath(agentDir) }),
  );
  await refreshAuthProfileFileState();
  expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(revision);
  expect(getRuntimeStore(agentDir)).toEqual(snapshot);
});

it.each(["native commit", "cold async read"] as const)(
  "retains a %s through observation",
  async (initial) => {
    const { agentDir } = fixture();
    const store = profileStore;
    if (initial === "native commit") {
      saveOwnedAuthProfiles(store("before"), agentDir);
      setRuntimeStore(loadAuthProfileStoreWithoutExternalProfiles(agentDir), agentDir);
      saveOwnedAuthProfiles(store("owned"), agentDir);
      const revision = getRuntimeAuthProfileStoreCredentialsRevision();

      await refreshAuthProfileFileState();

      expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(revision);
    } else {
      await promisify(execFile)(process.execPath, [
        "-e",
        'const fs = require("node:fs"); const path = require("node:path"); const { DatabaseSync } = require("node:sqlite"); fs.mkdirSync(path.dirname(process.argv[1]), { recursive: true }); const db = new DatabaseSync(process.argv[1]); try { db.exec("CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT); CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT)"); db.prepare("INSERT INTO auth_profile_store VALUES (?, ?)").run("primary", process.argv[2]); } finally { db.close(); }',
        resolveAuthProfileDatabasePath(agentDir),
        JSON.stringify(store("owned")),
      ]);
      await prepareSharedAuthStoreOwnership();
      setRuntimeStore(await loadRuntimeStore(agentDir, readOptions), agentDir);
    }
    expect(getRuntimeStore(agentDir)?.profiles.example).toMatchObject({
      key: "owned",
    });
    await refreshAuthProfileFileState();
    expect(getRuntimeStore(agentDir)?.profiles.example).toMatchObject({
      key: "owned",
    });
  },
);

it.each(["explicit refresh", "legacy source observation"] as const)(
  "publishes a separate process's auth edit through %s",
  async (refresh) => {
    const { root, agentDir } = fixture();
    vi.stubEnv("OPENCLAW_TEST_AUTH_KEY", "synthetic-before");
    const legacySource = refresh === "legacy source observation";
    const store = (key: string) => profileStore(key, legacySource);
    saveOwnedAuthProfiles(store("synthetic-before"), agentDir);
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: {
        agents: { ownership: "explicit", entries: { main: { agentDir, workspace: root } } },
        plugins: { enabled: false },
      },
      env: { HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_TEST_AUTH_KEY: "synthetic-before" },
      includeConfigRefs: false,
    });
    activateSecretsRuntimeSnapshot(snapshot);
    await loadRuntimeStore(agentDir, readOptions);
    const inactiveAgentDir = path.join(root, "agents", "later", "agent");
    if (legacySource) {
      setRuntimeStore(await loadRuntimeStore(inactiveAgentDir, readOptions), inactiveAgentDir);
    }
    const expectedKey = legacySource ? "synthetic-before" : "synthetic-after";
    await promisify(execFile)(
      process.execPath,
      legacySource
        ? [
            "-e",
            'require("node:fs").writeFileSync(process.argv[1], "{}");',
            path.join(agentDir, "auth.json"),
          ]
        : [
            "-e",
            'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); try { db.prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = ?").run(process.argv[2], "primary"); } finally { db.close(); }',
            resolveAuthProfileDatabasePath(agentDir),
            JSON.stringify(store("synthetic-after")),
          ],
    );
    if (refresh === "explicit refresh") {
      await refreshRuntimeAuthProfileStoreSources();
      await refreshActiveProviderAuthRuntimeSnapshot();
    } else {
      const published = new Promise<void>((resolve) => {
        const unsubscribe = registerRuntimeAuthProfileStoreMutationListener(() => {
          const profile = getRuntimeStore(agentDir)?.profiles.example;
          if (profile?.type !== "api_key" || profile.key !== expectedKey) {
            return;
          }
          unsubscribe();
          resolve();
        });
        mutationSubscriptions.push(unsubscribe);
      });
      const callbacks = observations.get(path.dirname(resolveAuthProfileDatabasePath(agentDir)));
      expect(callbacks?.size).toBeGreaterThan(0);
      for (const notify of callbacks ?? []) {
        notify();
      }
      await published;
    }
    expect(getRuntimeStore(agentDir)?.profiles.example).toMatchObject({
      type: "api_key",
      key: expectedKey,
    });
    expect(
      getActiveSecretsRuntimeSnapshot()?.authStores.find((entry) => entry.agentDir === agentDir)
        ?.store.profiles.example,
    ).toMatchObject({
      type: "api_key",
      key: expectedKey,
    });
    if (legacySource) {
      expect(getRuntimeStore(inactiveAgentDir)).toBeUndefined();
    }
  },
);

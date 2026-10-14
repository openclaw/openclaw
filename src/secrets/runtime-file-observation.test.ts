import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { refreshAuthProfileFileState } from "../agents/auth-profiles/file-state.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  refreshRuntimeAuthProfileStoreSources,
  registerRuntimeAuthProfileStoreMutationListener,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreForRuntimeAsync,
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
function saveOwnedAuthProfiles(store: AuthProfileStore, agentDir: string) {
  const lease = acquireStateDatabaseSchemaLease(resolveOpenClawStateSqlitePath());
  try {
    lease.run(() =>
      saveAuthProfileStore(store, agentDir, {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      }),
    );
  } finally {
    lease.release();
  }
}

afterEach(async () => {
  for (const unsubscribe of mutationSubscriptions.splice(0)) {
    unsubscribe();
  }
  clearSecretsRuntimeSnapshot();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it.each(["session admission", "foreign credentials"] as const)(
  "observes first-file %s after empty startup",
  async (creation) => {
    const root = temporary.make("auth-empty-startup-observation-");
    const agentDir = path.join(root, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    await prepareSharedAuthStoreOwnership();
    const prepared = prepareSecretsRuntimeFastPathSnapshot({
      config: { agents: { entries: { main: { agentDir } } }, plugins: { enabled: false } },
      agentDirs: [agentDir],
    });
    expect(prepared).not.toBeNull();
    activateSecretsRuntimeSnapshot(prepared!.snapshot);
    const snapshot = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
    const revision = getRuntimeAuthProfileStoreCredentialsRevision();
    const snapshotsRevision = getRuntimeAuthProfileStoreSnapshotsRevision();
    const publication =
      creation === "foreign credentials"
        ? new Promise<void>((resolve) => {
            mutationSubscriptions.push(
              registerRuntimeAuthProfileStoreMutationListener(() => resolve()),
            );
          })
        : undefined;
    if (creation === "session admission") {
      const lease = acquireStateDatabaseSchemaLease(resolveOpenClawStateSqlitePath());
      try {
        lease.run(() =>
          openOpenClawAgentDatabase({
            agentId: "main",
            path: resolveAuthProfileDatabasePath(agentDir),
          }),
        );
      } finally {
        lease.release();
      }
    } else {
      await promisify(execFile)(process.execPath, [
        "-e",
        'const fs = require("node:fs"); const path = require("node:path"); const { DatabaseSync } = require("node:sqlite"); fs.mkdirSync(path.dirname(process.argv[1]), { recursive: true }); const db = new DatabaseSync(process.argv[1]); try { db.exec("CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT); CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT)"); db.prepare("INSERT INTO auth_profile_store VALUES (?, ?)").run("primary", process.argv[2]); } finally { db.close(); }',
        resolveAuthProfileDatabasePath(agentDir),
        JSON.stringify({
          version: 1,
          profiles: { example: { type: "api_key", provider: "openai", key: "foreign" } },
        }),
      ]);
    }
    await refreshAuthProfileFileState();
    await publication;
    if (creation === "session admission") {
      expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(revision);
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toEqual(snapshot);
    } else {
      expect(getRuntimeAuthProfileStoreSnapshotsRevision()).toBeGreaterThan(snapshotsRevision);
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles.example).toMatchObject({
        key: "foreign",
      });
    }
  },
);

it.each(["native commit", "cold async read"] as const)(
  "retains a %s through observation and detects a later foreign edit",
  async (initial) => {
    const root = temporary.make("auth-own-write-observation-");
    const agentDir = path.join(root, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const store = (key: string) => ({
      version: 1,
      profiles: { example: { type: "api_key" as const, provider: "openai", key } },
    });
    if (initial === "native commit") {
      saveOwnedAuthProfiles(store("before"), agentDir);
      setRuntimeAuthProfileStoreSnapshot(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir),
        agentDir,
      );
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
      setRuntimeAuthProfileStoreSnapshot(
        await loadAuthProfileStoreForRuntimeAsync(agentDir, {
          readOnly: true,
          externalCli: { mode: "none" },
        }),
        agentDir,
      );
    }
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles.example).toMatchObject({
      key: "owned",
    });
    await promisify(execFile)(process.execPath, [
      "-e",
      'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); try { db.prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = ?").run(process.argv[2], "primary"); } finally { db.close(); }',
      resolveAuthProfileDatabasePath(agentDir),
      JSON.stringify(store("foreign")),
    ]);
    await refreshAuthProfileFileState();

    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
  },
);

it.each(["observation", "explicit refresh", "legacy source observation"] as const)(
  "publishes a separate process's auth edit through %s",
  async (refresh) => {
    const root = temporary.make("auth-observation-publication-");
    const agentDir = path.join(root, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_TEST_AUTH_KEY", "synthetic-before");
    const legacySource = refresh === "legacy source observation";
    const store = (key: string) => ({
      version: 1,
      profiles: {
        example: {
          type: "api_key" as const,
          provider: "openai",
          ...(legacySource
            ? {
                keyRef: {
                  source: "env" as const,
                  provider: "default",
                  id: "OPENCLAW_TEST_AUTH_KEY",
                },
              }
            : { key }),
        },
      },
    });
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
    await loadAuthProfileStoreForRuntimeAsync(agentDir, {
      readOnly: true,
      externalCli: { mode: "none" },
    });
    const inactiveAgentDir = path.join(root, "agents", "later", "agent");
    if (legacySource) {
      setRuntimeAuthProfileStoreSnapshot(
        await loadAuthProfileStoreForRuntimeAsync(inactiveAgentDir, {
          readOnly: true,
          externalCli: { mode: "none" },
        }),
        inactiveAgentDir,
      );
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
          const profile = getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles.example;
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
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles.example).toMatchObject({
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
      expect(getRuntimeAuthProfileStoreSnapshotCore(inactiveAgentDir)).toBeUndefined();
    }
  },
);

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import { resolveStateDir } from "../paths.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

const roots = createTempDirTracker();
const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];

beforeEach(() => {
  resetConfigRuntimeState();
  setRuntimeConfigSnapshot({}, {});
});

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await Promise.allSettled(pending.splice(0));
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
  roots.cleanup();
});

function own<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

function fixture(sessionKey = "agent:main:admission") {
  const root = roots.make("session-patch-admission-");
  const env = { OPENCLAW_STATE_DIR: root };
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const scope = { agentId: "main", env, sessionKey };
  replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1 });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  return { root, env, scope, databasePath: database.path };
}

function blockWriter(scope: Parameters<typeof resolveSqliteScope>[0]) {
  const release = createDeferred();
  releases.push(() => release.resolve());
  const blocker = own(
    runExclusiveSqliteSessionWrite(
      resolveSqliteScope(scope),
      () => release.promise,
      "session.transcript.batch",
    ),
  );
  return { release, blocker };
}

it.each(["sessions.json", "custom.json"])(
  "keeps concurrent first writes in one custom store (%s)",
  async (filename) => {
    const root = roots.make("session-patch-first-writes-");
    const env = { OPENCLAW_STATE_DIR: root };
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const storePath = path.join(root, "custom-store", filename);
    const entries = ["first", "second", "third"].map((name) => ({
      sessionKey: `agent:main:${name}`,
      entry: { sessionId: `session-${name}`, updatedAt: Date.now() },
    }));
    await Promise.all(
      entries.map(({ sessionKey, entry }) =>
        own(replaceSessionEntry({ env, storePath, sessionKey }, entry)),
      ),
    );
    expect(
      entries.map(({ sessionKey }) => loadSessionEntry({ env, storePath, sessionKey })?.sessionId),
    ).toEqual(entries.map(({ entry }) => entry.sessionId));
    expect(
      fs.readdirSync(path.dirname(storePath)).filter((entryName) => entryName.endsWith(".sqlite")),
    ).toHaveLength(1);
  },
);

it("patches the process-held incognito store without creating durable files", async () => {
  const f = fixture("agent:main:dashboard:incognito-admission");
  await expect(
    own(patchSessionEntryCore(f.scope, () => ({ label: "incognito" }), { skipMaintenance: true })),
  ).resolves.toMatchObject({ sessionId: "original", label: "incognito" });
  expect(loadSessionEntry(f.scope)).toMatchObject({ label: "incognito" });
  expect(fs.readdirSync(f.root)).toEqual([]);
});

it.each([false, true])(
  "captures the queued state owner before admission (ambient=%s)",
  async (ambient) => {
    const f = fixture();
    const original = { ...f.scope, env: { ...f.env } };
    const successor = roots.make("session-patch-successor-");
    const { release, blocker } = blockWriter(original);
    const scope = ambient ? { agentId: "main", sessionKey: original.sessionKey } : f.scope;
    const operation = own(
      patchSessionEntryCore(scope, () => ({ label: "original owner" }), { skipMaintenance: true }),
    );
    if (ambient) {
      vi.stubEnv("OPENCLAW_STATE_DIR", successor);
    } else {
      f.env.OPENCLAW_STATE_DIR = successor;
    }
    release.resolve();
    await blocker;
    await expect(operation).resolves.toMatchObject({
      sessionId: "original",
      label: "original owner",
    });
    expect(loadSessionEntry(original)).toMatchObject({ label: "original owner" });
    expect(fs.readdirSync(successor)).toEqual([]);
  },
);

it("keeps the physical database owner for logical rows in a shared store", async () => {
  const f = fixture();
  const storePath = path.join(f.root, "shared.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", env: f.env, path: storePath });
  const main = { ...f.scope, storePath, sessionKey: "agent:main:kept" };
  const secondary = { ...main, agentId: "secondary", sessionKey: "agent:secondary:shared" };
  replaceSessionEntrySync(main, { sessionId: "kept", updatedAt: 1 });
  replaceSessionEntrySync(secondary, { sessionId: "secondary", updatedAt: 1 });
  await closeOpenClawAgentDatabaseByPathAsync(storePath);
  await expect(
    own(
      patchSessionEntryCore(secondary, () => ({ label: "shared owner" }), {
        skipMaintenance: true,
      }),
    ),
  ).resolves.toMatchObject({ sessionId: "secondary", label: "shared owner" });
  expect(loadSessionEntry(main)).toMatchObject({ sessionId: "kept" });
  expect(
    openOpenClawAgentDatabase({ agentId: "main", env: f.env, path: storePath })
      .db.prepare("SELECT agent_id FROM schema_meta")
      .get(),
  ).toMatchObject({ agent_id: "main" });
  expect(
    fs.existsSync(path.join(f.root, "agents", "secondary", "agent", "openclaw-agent.sqlite")),
  ).toBe(false);
});

it("rejects retirement at worker admission before the updater and allows a fresh successor", async () => {
  const f = fixture();
  const createAdmission = admission.createSqliteWorkerOperationAdmission;
  let retired = false;
  const observer = vi
    .spyOn(admission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((callback, attachment) =>
      createAdmission((request, grant) => {
        if (!retired && request.stage === "open") {
          retired = true;
          closeOpenClawAgentDatabaseByPath(f.databasePath);
        }
        callback(request, grant);
      }, attachment),
    );
  const update = vi.fn(() => ({ label: "must not commit" }));
  const committed = vi.fn();
  try {
    await expect(
      own(
        patchSessionEntryCore(f.scope, update, { skipMaintenance: true, onCommitted: committed }),
      ),
    ).rejects.toThrow(/closed|revoked|replaced/);
    expect(retired).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  } finally {
    observer.mockRestore();
  }
  await closeOpenClawAgentDatabaseByPathAsync(f.databasePath);
  expect(loadSessionEntry(f.scope)).not.toHaveProperty("label");
  await expect(
    own(patchSessionEntryCore(f.scope, () => ({ label: "successor" }), { skipMaintenance: true })),
  ).resolves.toMatchObject({ sessionId: "original", label: "successor" });
});

it.each(["relative queued", "relative preparation", "implicit queued"] as const)(
  "pins the selected root for %s patch work",
  async (mode) => {
    const home = roots.make("session-patch-root-selection-");
    const implicit = mode === "implicit queued";
    const ownerRoot = path.join(home, implicit ? ".clawdbot" : "state");
    const successor = path.join(home, implicit ? ".openclaw" : "next-cwd");
    fs.mkdirSync(ownerRoot);
    if (!implicit) {
      fs.mkdirSync(successor);
    }
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      OPENCLAW_HOME: home,
      OPENCLAW_CONFIG_PATH: path.join(ownerRoot, "openclaw.json"),
      ...(implicit
        ? // Select legacy discovery rather than the fast-test new-root shortcut.
          { OPENCLAW_TEST_FAST: "0" }
        : { OPENCLAW_STATE_DIR: "state" }),
    };
    vi.stubEnv("OPENCLAW_STATE_DIR", ownerRoot);
    const scope = { agentId: "main", env, sessionKey: "agent:main:root-selection" };
    const original = { ...scope, env: { ...env, OPENCLAW_STATE_DIR: ownerRoot } };
    expect(resolveStateDir(env)).toBe(ownerRoot);
    replaceSessionEntrySync(original, { sessionId: "original", updatedAt: 1 });
    const shiftOwner = () => {
      if (implicit) {
        fs.mkdirSync(successor);
      } else {
        cwd.mockReturnValue(successor);
      }
    };
    const gate = mode === "relative preparation" ? undefined : blockWriter(original);
    const operation = own(
      patchSessionEntryCore(
        scope,
        () => {
          if (!gate) {
            shiftOwner();
          }
          return { label: "retained selected root" };
        },
        { skipMaintenance: true },
      ),
    );
    if (gate) {
      shiftOwner();
      gate.release.resolve();
      await gate.blocker;
    }
    await expect(operation).resolves.toMatchObject({
      sessionId: "original",
      label: "retained selected root",
    });
    // Unchanged caller inputs now select elsewhere; the in-flight operation retained its root.
    expect(resolveStateDir(env)).toBe(implicit ? successor : path.join(successor, "state"));
    expect(loadSessionEntry(original)).toMatchObject({
      sessionId: "original",
      label: "retained selected root",
    });
    expect(env.OPENCLAW_STATE_DIR).toBe(implicit ? undefined : "state");
    expect(fs.readdirSync(successor, { recursive: true })).toEqual([]);
  },
);

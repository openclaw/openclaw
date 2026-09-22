import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { resetPluginStateStoreForTests } from "../../plugin-sdk/plugin-state-test-runtime.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
} from "../../plugins/loader.test-fixtures.js";
import {
  closeActiveMemorySearchManagersCore,
  getActiveMemorySearchManagerCore,
} from "../../plugins/memory-runtime.js";
import { resetStandaloneMemoryRegistrySlot } from "../../plugins/memory-runtime.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntry,
} from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";

const checkpoint = vi.hoisted(() => ({
  startForeground: undefined as (() => void) | undefined,
  authorizations: [] as Promise<void>[],
}));

vi.mock("./session-accessor.sqlite-worker-request.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-worker-request.js")>();
  return {
    ...actual,
    runSqliteMutationWorkerRequest: <Result>(
      params: Parameters<typeof actual.runSqliteMutationWorkerRequest<Result>>[0],
    ) => {
      let inWriteAdmission: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
      return actual.runSqliteMutationWorkerRequest<Result>({
        ...params,
        withWriteAdmission: (performWrite, diagnostics) =>
          params.withWriteAdmission((refusal) => {
            // Bound Worker messages otherwise run outside the active writer context.
            inWriteAdmission = AsyncLocalStorage.snapshot();
            return performWrite(refusal);
          }, diagnostics),
        onCommitRequest: () => {
          if (!inWriteAdmission) {
            throw new Error("Worker requested commit without writer admission");
          }
          inWriteAdmission(() => checkpoint.startForeground?.());
          // Let prepared foreground continuations run before the queued parent
          // authorizer, while the actual reclamation Worker holds its writer lock.
          const authorization = setImmediate().then(() => {
            params.onCommitRequest();
          });
          checkpoint.authorizations.push(authorization);
          void authorization.catch(() => {});
        },
      });
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("reclamation with the public memory runtime", () => {
  let workspace: string;
  let closeManager: (() => Promise<void>) | undefined;

  afterAll(cleanupPluginLoaderFixturesForTest);

  beforeEach(async () => {
    clearPluginLoaderCache();
    resetStandaloneMemoryRegistrySlot();
    const root = await fs.realpath(tempDirs.make("openclaw-reclamation-memory-"));
    workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(
      path.join(workspace, "MEMORY.md"),
      "A retained memory independent of the deleted session.",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  });

  afterEach(async () => {
    checkpoint.startForeground = undefined;
    await Promise.allSettled(checkpoint.authorizations.splice(0));
    await closeManager?.();
    closeManager = undefined;
    await closeActiveMemorySearchManagersCore();
    resetStandaloneMemoryRegistrySlot();
    clearPluginLoaderCache();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    resetPluginStateStoreForTests();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("settles borrowed cache cleanup and guarded deletion without blocking the authorizer", async () => {
    const cfg: OpenClawConfig = {
      plugins: {
        enabled: true,
        allow: ["memory-core"],
        slots: { memory: "memory-core" },
      },
      memory: {
        search: {
          provider: "none",
          cache: { enabled: true },
          store: { vector: { enabled: false } },
        },
      },
      agents: { defaults: { workspace }, list: [{ id: "main", default: true }] },
    };
    const acquired = await getActiveMemorySearchManagerCore({
      cfg,
      agentId: "main",
      purpose: "cli",
    });
    const manager = acquired.manager;
    if (!manager?.sync) {
      throw new Error(acquired.error ?? "expected the builtin memory manager");
    }
    closeManager = manager.close?.bind(manager);
    const sync = manager.sync.bind(manager);
    await sync({ reason: "prepare-published-index", force: true });
    const initial = manager.status();
    const storePath = initial.dbPath;
    const maxEntries = initial.cache?.maxEntries;
    if (!storePath || !maxEntries) {
      throw new Error("expected a borrowed database with the runtime cache bound");
    }
    const { db } = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    const sessionKey = "agent:main:memory-reclamation";
    const sessionId = "memory-reclamation";
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey },
      { sessionId, updatedAt: 1 },
    );
    await replaceTranscriptEvents({ agentId: "main", storePath, sessionKey, sessionId }, [
      { type: "session", id: sessionId, content: "retire this unrelated session" },
    ]);
    const insert = db.prepare(`INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('fixture', 'fixture-model', 'fixture-owner', ?, '[1]', 1, ?)`);
    runSqliteImmediateTransactionSync(db, () => {
      for (let index = 0; index <= maxEntries; index += 1) {
        insert.run(`entry-${index}`, index);
      }
    });
    expect(manager.status().cache?.entries).toBe(maxEntries + 1);
    let write: Promise<void> | undefined;
    checkpoint.startForeground = () => {
      write = sync({ reason: "reclamation-overlap" });
      void write.catch(() => {});
    };
    const deletion = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      commitGuard: () => {},
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const outcomes = await Promise.allSettled(write ? [write] : []);
    const authorizations = await Promise.allSettled(checkpoint.authorizations);
    expect(outcomes).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(deletion).toMatchObject({ result: { deleted: true } });
    expect(authorizations).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
    expect(manager.status().cache?.entries).toBe(maxEntries);
    expect(
      db
        .prepare("SELECT hash FROM memory_embedding_cache WHERE hash IN (?, ?)")
        .all("entry-0", `entry-${maxEntries}`),
    ).toEqual([{ hash: `entry-${maxEntries}` }]);
    expect(manager.status().chunks).toBeGreaterThan(0);
  });
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as admission from "../../infra/sqlite-database-admission.js";
import { deleteSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import * as stateDb from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import * as sessionArchive from "./session-accessor.sqlite-archive.js";
import { cleanupSessionLifecycleArtifactsCore } from "./session-accessor.sqlite-artifact-cleanup.js";
import {
  runSqliteSessionDeletionTransaction as transaction,
  withSqliteSessionContextReset as resetContext,
  withSqliteSessionDeletions as withDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { seedPersonalGitHubDeletionReceipt } from "./session-accessor.sqlite-deletion.test-support.js";
import { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-store.js";
import * as entries from "./session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { emptySessionEntryMaintenancePlan } from "./session-accessor.sqlite-maintenance-store.js";
import { finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort as finalizeMaintenance } from "./session-accessor.sqlite-maintenance.js";
import { applySessionEntryLifecycleMutation as mutate } from "./session-accessor.sqlite-projection.js";
import * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { mutateMemory } from "./session-actor-memory-publication.test-support.js";
import { acquireSessionActorStorage } from "./session-actor-storage-binding.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let storePath: string;
const sessionKey = "agent:main:cron:cleanup:run:session";
const baseKey = "agent:main:cron:cleanup";
const sessionId = "cleanup-session";

beforeEach(() => {
  resetConfigRuntimeState();
  // Automatic upkeep is separate from the scoped deletion receipt contract.
  const config = { session: { maintenance: { mode: "warn" as const } } };
  setRuntimeConfigSnapshot(config, config);
  const tempDir = tempDirs.make("openclaw-session-deletion-receipts-");
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
  agentDb.closeOpenClawAgentDatabasesForTest();
  stateDb.closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
});

async function seed(key = sessionKey, id = sessionId, lifecycleRevision = "generation-1") {
  await entries.replaceSessionEntry(
    { sessionKey: key, storePath },
    { sessionId: id, lifecycleRevision, updatedAt: Date.now() },
  );
}

const read = (key = sessionKey) =>
  entries.loadSessionEntry({ sessionKey: key, storePath, readConsistency: "latest" });

const seedReceipt = (key = sessionKey) => seedPersonalGitHubDeletionReceipt(key, sessionId);
const scope = () => resolveSqliteScope({ sessionKey, storePath });
const retired = { receipt: undefined, lifecycle: undefined };
async function seedPair() {
  await seed();
  await seed(baseKey);
  const removed = await seedReceipt();
  const retained = await seedReceipt(baseKey);
  return { removed, retained, before: retained() };
}

it.each([false, true])(
  "releases deleted session scopes without reviving old receipts or invalidating another session (transcript=%s)",
  async (withTranscript) => {
    await seed();
    if (withTranscript) {
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
        { type: "session", id: sessionId },
      ]);
    }
    const unrelatedSessionId = "unrelated-session";
    await seed(baseKey, unrelatedSessionId, "unrelated-1");
    const options = toDatabaseOptions(scope());
    const database = agentDb.openOpenClawAgentDatabase(options);
    const token = (
      keys: Parameters<typeof admission.readSqliteDatabaseScopedWriteTokenForPath>[1],
    ) => admission.readSqliteDatabaseScopedWriteTokenForPath(database.path, keys);
    const admissions = () =>
      admission
        .captureSqliteDatabaseAdmissions()
        .filter((record) => record.location === database.path);
    const scopes = [sessionKey, admission.sqliteSessionIdWriteScope(sessionId)];
    const unrelatedScopes = [baseKey, admission.sqliteSessionIdWriteScope(unrelatedSessionId)];
    token(scopes);
    token(unrelatedScopes);
    const scopeCount = () => admissions()[0]?.writeScopes.size;
    const retainedBefore = scopeCount();
    expect(retainedBefore).toBeGreaterThanOrEqual(4);
    const failure = new Error("rollback receipt retirement");
    expect(() =>
      transaction((current) => {
        deleteSessionEntryRows(current, sessionKey, { deleteOwnedWindows: true });
        throw failure;
      }, options),
    ).toThrow(failure);
    expect(scopeCount()).toBe(retainedBefore);
    expect(read()?.sessionId).toBe(sessionId);

    const before = token(scopes);
    const unrelated = token(unrelatedScopes);
    const stale = structuredClone(admissions());
    expect(before).toBeTypeOf("string");
    expect(unrelated).toBeTypeOf("string");

    let closeRetained: (() => Promise<void>) | undefined;
    const withWorker = reclamationWorker.withSqliteReclamationWorker;
    vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
      (workerOptions, source, run, ...rest) =>
        withWorker(
          workerOptions,
          source,
          async (worker) => {
            closeRetained = () => worker.close();
            return run(worker);
          },
          ...rest,
        ),
    );

    await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    });
    if (withTranscript) {
      const closeWorker = closeRetained;
      assert(closeWorker, "Expected the deletion's real reclamation Worker");
      await closeWorker();
    } else {
      expect(closeRetained).toBeUndefined();
    }

    expect(scopeCount()).toBe(retainedBefore! - 2);
    admission.installSqliteDatabaseAdmissions(stale);
    expect(scopeCount()).toBe(retainedBefore! - 2);
    expect(read()).toBeUndefined();
    expect(token(unrelatedScopes)).toBe(unrelated);
    await seed();
    expect(token(scopes)).not.toBe(before);
    expect(token(unrelatedScopes)).toBe(unrelated);
    expect(read(baseKey)?.sessionId).toBe(unrelatedSessionId);
  },
);

it("retires a replaced legacy key while retaining the transferred window scope", async () => {
  await seed();
  const database = agentDb.openOpenClawAgentDatabase(toDatabaseOptions(scope()));
  admission.readSqliteDatabaseScopedWriteTokenForPath(database.path, [
    sessionKey,
    baseKey,
    admission.sqliteSessionIdWriteScope(sessionId),
  ]);
  const scopes = () =>
    admission.captureSqliteDatabaseAdmissions().find((record) => record.location === database.path)!
      .writeScopes;
  const retained = new Map(scopes());
  expect(retained.delete(JSON.stringify(["key", sessionKey]))).toBe(true);
  const stale = structuredClone(admission.captureSqliteDatabaseAdmissions());

  await mutate({
    storePath,
    removals: [{ sessionKey }],
    upserts: [{ sessionKey: baseKey, entry: read()! }],
    skipMaintenance: true,
  });

  expect(scopes()).toEqual(retained);
  admission.installSqliteDatabaseAdmissions(stale);
  expect(scopes()).toEqual(retained);
  expect(read()).toBeUndefined();
  expect(read(baseKey)?.sessionId).toBe(sessionId);
});

it.each([false, true])(
  "settles memory maintenance receipts only for deleted entries (changed=%s)",
  async (changed) => {
    const incognitoKey = "agent:main:dashboard:incognito-maintenance-receipt";
    const env = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
    const authority = { assertCurrent() {}, authorize() {} };
    const binding = await acquireSessionActorStorage(
      { agentId: "main", env, sessionKey: incognitoKey },
      { authority, lifetime: { assertCurrent() {}, assertReadable() {} }, create: true },
    );
    assert(binding, "Expected memory session actor");
    const owner = memorySessionActorOwners.read(binding)!;
    try {
      const created = await mutateMemory(
        binding.actor.storage,
        "session.entry.create",
        {
          entry: { sessionId, lifecycleRevision: "generation-1", updatedAt: 1, incognito: true },
        },
        authority,
      );
      assert(created.kind === "committed", "Memory entry creation failed");
      const entry = created.value;
      const receipt = await seedReceipt(incognitoKey);
      expect(receipt().receipt).toBeDefined();
      const plan = emptySessionEntryMaintenancePlan();
      plan.entryRemovals = [
        { sessionKey: incognitoKey, expectedEntry: entry, maintenanceReason: "pruned" },
      ];
      if (changed) {
        expect(
          await mutateMemory(
            binding.actor.storage,
            "session.entry.patch",
            {
              operation: { kind: "fields", patch: { label: "Concurrent update" } },
            },
            authority,
          ),
        ).toMatchObject({ kind: "committed" });
      }
      const result = await finalizeMaintenance(
        { agentId: binding.agentId, path: binding.path, env },
        [plan],
      );
      expect(result.pruned).toBe(changed ? 0 : 1);
      if (changed) {
        expect(owner.readSession(incognitoKey, authority)?.entry?.label).toBe("Concurrent update");
        expect(receipt().receipt).toBeDefined();
      } else {
        expect(owner.readSession(incognitoKey, authority)).toBeUndefined();
        expect(receipt()).toEqual(retired);
      }
    } finally {
      await binding.actor.release();
      memorySessionActorOwners.closeDatabase(binding);
    }
  },
);

it.runIf(process.platform !== "win32").each([false, true])(
  "settles workspace-free receipts against the original database after an alias retarget (aborted: %s)",
  async (aborted) => {
    const directory = tempDirs.make("receipt-cleanup-alias-");
    const originalPath = path.join(directory, "original.sqlite");
    const replacementPath = path.join(directory, "replacement.sqlite");
    const alias = path.join(directory, "alias.sqlite");
    storePath = originalPath;
    await seed(sessionKey);
    const receipt = await seedReceipt();
    const before = receipt();
    if (aborted) {
      agentDb.openOpenClawAgentDatabase({ agentId: "main", path: replacementPath });
    }
    // Checkpoint before copying so the replacement's same-key row is durable.
    await agentDb.closeOpenClawAgentDatabasesAsync();
    if (!aborted) {
      await fs.copyFile(originalPath, replacementPath);
    }
    await fs.symlink(originalPath, alias);
    expect(entries.loadSessionEntry({ sessionKey, storePath: alias })).toMatchObject({ sessionId });
    const failure = new Error("artifact deletion aborted before commit");
    const materialize = sessionArchive.materializeSessionStateDeletePlans;
    vi.spyOn(sessionArchive, "materializeSessionStateDeletePlans").mockImplementationOnce(
      async (...args) => {
        const result = await materialize(...args);
        await fs.unlink(alias);
        await fs.symlink(replacementPath, alias);
        if (aborted) {
          throw failure;
        }
        return result;
      },
    );

    const cleanup = cleanupSessionLifecycleArtifactsCore({
      agentId: "main",
      storePath: alias,
      sessionKeySegmentPrefix: "cron:cleanup:",
      transcriptContentMarker: "receipt-cleanup",
      archiveRemovedEntryTranscripts: false,
      orphanTranscriptMinAgeMs: 0,
    });
    if (aborted) {
      await expect(cleanup).rejects.toBe(failure);
      expect(read()).toMatchObject({ sessionId });
      expect(receipt()).toEqual(before);
    } else {
      await expect(cleanup).resolves.toMatchObject({ removedEntries: 1 });
      expect(read()).toBeUndefined();
      expect(receipt()).toEqual(retired);
    }
    expect(entries.loadSessionEntry({ sessionKey, storePath: replacementPath })?.sessionId).toBe(
      aborted ? undefined : sessionId,
    );
  },
);

it.each(["projection", "SDK"])(
  "removes workspace-free publication receipts through %s",
  async (entryPoint) => {
    const { removed: receipt, retained: unrelated, before: unrelatedBefore } = await seedPair();
    expect(receipt().lifecycle).toMatchObject({ lifecycle_revision: "generation-1" });
    if (entryPoint === "SDK") {
      await expect(deleteSessionEntry({ storePath, sessionKey })).resolves.toBe(true);
    } else {
      await mutate({
        storePath,
        removals: [{ sessionKey }],
        skipMaintenance: true,
      });
    }
    expect(read()).toBeUndefined();
    expect(receipt()).toEqual(retired);
    expect(read(baseKey)?.sessionId).toBe(sessionId);
    expect(unrelated()).toEqual(unrelatedBefore);
  },
);

it("settles only committed rows when a batch deletion fails partway through", async () => {
  const { removed, retained, before } = await seedPair();
  const currentScope = scope();
  const targets = [sessionKey, baseKey].map((key) => ({ sessionKey: key, entry: read(key)! }));
  const failure = new Error("batch deletion aborted after its first commit");

  await expect(
    withDeletions(currentScope, targets, async () => {
      transaction(
        (database) => deleteSessionEntryRows(database, sessionKey),
        toDatabaseOptions(currentScope),
      );
      throw failure;
    }),
  ).rejects.toBe(failure);

  expect(read()).toBeUndefined();
  expect(removed()).toEqual(retired);
  expect(read(baseKey)).toEqual(targets[1]!.entry);
  expect(retained()).toEqual(before);
});

it("retains personal publication receipts when deletion aborts or the context resets", async () => {
  await seed(sessionKey);
  const receipt = await seedReceipt();
  const before = receipt();
  const entry = read()!;
  const currentScope = scope();
  const failure = new Error("deletion aborted before commit");

  await expect(
    withDeletions(currentScope, [{ sessionKey, entry }], async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(read()).toEqual(entry);
  expect(receipt()).toEqual(before);

  await resetContext(currentScope, { sessionKey, entry }, async () => {
    await entries.patchSessionEntryCore(
      { sessionKey, storePath },
      () => ({ label: "context reset" }),
      {
        skipMaintenance: true,
      },
    );
  });
  expect(read()).toMatchObject({ sessionId, label: "context reset" });
  expect(receipt()).toEqual(before);
});

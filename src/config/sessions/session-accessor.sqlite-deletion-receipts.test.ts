import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { deleteSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { openIncognitoTestActor } from "../../state/openclaw-agent-execution-incognito.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import * as sessionArchive from "./session-accessor.sqlite-archive.js";
import { cleanupSessionLifecycleArtifactsCore } from "./session-accessor.sqlite-artifact-cleanup.js";
import {
  runSqliteSessionDeletionTransaction,
  withSqliteSessionContextReset,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { seedPersonalGitHubDeletionReceipt } from "./session-accessor.sqlite-deletion.test-support.js";
import { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-store.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "./session-accessor.sqlite-entry.js";
import { emptySessionEntryMaintenancePlan } from "./session-accessor.sqlite-maintenance-store.js";
import { finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort } from "./session-accessor.sqlite-maintenance.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { withIncognitoSessionBinding } from "./session-incognito-binding.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite session deletion receipts", () => {
  let storePath: string;
  const sessionKey = "agent:main:cron:cleanup:run:session";
  const baseKey = "agent:main:cron:cleanup";
  const sessionId = "cleanup-session";

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-session-deletion-receipts-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  async function seed(key = sessionKey) {
    await replaceSessionEntry(
      { sessionKey: key, storePath },
      { sessionId, lifecycleRevision: "generation-1", updatedAt: Date.now() },
    );
  }

  const read = (key = sessionKey) =>
    loadSessionEntry({ sessionKey: key, storePath, readConsistency: "latest" });

  const seedReceipt = (key = sessionKey) => seedPersonalGitHubDeletionReceipt(key, sessionId);

  it("removes a deleted incognito session's personal receipt during maintenance", async () => {
    const incognitoKey = "agent:main:dashboard:incognito-maintenance-receipt";
    const env = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
    const authority = { assertCurrent() {} };
    const actor = await openIncognitoTestActor(env, authority);
    try {
      const { entry } = await actor.sessions.create(authority, {
        sessionKey: incognitoKey,
        entry: { sessionId, lifecycleRevision: "generation-1", updatedAt: 1, incognito: true },
      });
      const receipt = await seedReceipt(incognitoKey);
      expect(receipt().receipt).toBeDefined();
      const plan = emptySessionEntryMaintenancePlan();
      plan.entryRemovals = [
        { sessionKey: incognitoKey, expectedEntry: entry, maintenanceReason: "pruned" },
      ];

      const result = await withIncognitoSessionBinding({ actor }, () =>
        finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
          { agentId: actor.agentId, path: actor.path, env },
          [plan],
        ),
      );

      expect(result.pruned).toBe(1);
      expect(
        (await actor.sessions.read(authority, { sessionKey: incognitoKey })).entry,
      ).toBeUndefined();
      expect(receipt()).toEqual({ receipt: undefined, lifecycle: undefined });
    } finally {
      await actor.close();
    }
  });

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
        openOpenClawAgentDatabase({ agentId: "main", path: replacementPath });
      }
      // Checkpoint before copying so the replacement's same-key row is durable.
      await closeOpenClawAgentDatabasesAsync();
      if (!aborted) {
        await fs.copyFile(originalPath, replacementPath);
      }
      await fs.symlink(originalPath, alias);
      expect(loadSessionEntry({ sessionKey, storePath: alias })).toMatchObject({ sessionId });
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
        expect(receipt()).toEqual({ receipt: undefined, lifecycle: undefined });
      }
      expect(loadSessionEntry({ sessionKey, storePath: replacementPath })?.sessionId).toBe(
        aborted ? undefined : sessionId,
      );
    },
  );

  it("removes personal publication receipts without a repository workspace during projection cleanup", async () => {
    await seed(sessionKey);
    await seed(baseKey);
    const receipt = await seedReceipt();
    const unrelated = await seedReceipt(baseKey);
    const unrelatedBefore = unrelated();
    expect(receipt().lifecycle).toMatchObject({ lifecycle_revision: "generation-1" });

    await applySessionEntryLifecycleMutation({
      storePath,
      removals: [{ sessionKey }],
      skipMaintenance: true,
    });

    expect(read()).toBeUndefined();
    expect(receipt()).toEqual({ receipt: undefined, lifecycle: undefined });
    expect(read(baseKey)?.sessionId).toBe(sessionId);
    expect(unrelated()).toEqual(unrelatedBefore);
  });

  it("removes personal publication receipts without a repository workspace through the SDK", async () => {
    await seed(sessionKey);
    const receipt = await seedReceipt();

    await expect(deleteSessionEntry({ storePath, sessionKey })).resolves.toBe(true);

    expect(read()).toBeUndefined();
    expect(receipt()).toEqual({ receipt: undefined, lifecycle: undefined });
  });

  it("settles only committed rows when a batch deletion fails partway through", async () => {
    await seed(sessionKey);
    await seed(baseKey);
    const removedReceipt = await seedReceipt();
    const retainedReceipt = await seedReceipt(baseKey);
    const retainedBefore = retainedReceipt();
    const scope = resolveSqliteScope({ sessionKey, storePath });
    const entries = [sessionKey, baseKey].map((key) => ({ sessionKey: key, entry: read(key)! }));
    const failure = new Error("batch deletion aborted after its first commit");

    await expect(
      withSqliteSessionDeletions(scope, entries, async () => {
        runSqliteSessionDeletionTransaction(
          (database) => deleteSessionEntryRows(database, sessionKey),
          toDatabaseOptions(scope),
        );
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(read()).toBeUndefined();
    expect(removedReceipt()).toEqual({ receipt: undefined, lifecycle: undefined });
    expect(read(baseKey)).toEqual(entries[1]!.entry);
    expect(retainedReceipt()).toEqual(retainedBefore);
  });

  it("retains personal publication receipts when deletion aborts or the context resets", async () => {
    await seed(sessionKey);
    const receipt = await seedReceipt();
    const before = receipt();
    const entry = read()!;
    const scope = resolveSqliteScope({ sessionKey, storePath });
    const failure = new Error("deletion aborted before commit");

    await expect(
      withSqliteSessionDeletions(scope, [{ sessionKey, entry }], async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(read()).toEqual(entry);
    expect(receipt()).toEqual(before);

    await withSqliteSessionContextReset(scope, { sessionKey, entry }, async () => {
      await patchSessionEntryCore({ sessionKey, storePath }, () => ({ label: "context reset" }), {
        skipMaintenance: true,
      });
    });
    expect(read()).toMatchObject({ sessionId, label: "context reset" });
    expect(receipt()).toEqual(before);
  });
});

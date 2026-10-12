import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  beforeMaterialize: undefined as (() => Promise<void>) | undefined,
  beforeReclaim: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("./session-accessor.sqlite-reclamation-run.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-reclamation-run.js")>();
  return {
    ...actual,
    runSqliteSessionReclamation: async (
      ...args: Parameters<typeof actual.runSqliteSessionReclamation>
    ) => {
      await archiveMaterializationHook.beforeReclaim?.();
      return await actual.runSqliteSessionReclamation(...args);
    },
  };
});

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      await archiveMaterializationHook.beforeMaterialize?.();
      return await actual.materializeSessionStateDeletePlans(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
describe("SQLite reclamation admission races", () => {
  let storePath: string;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-session-reclamation-admission-race-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(async () => {
    archiveMaterializationHook.beforeMaterialize = undefined;
    archiveMaterializationHook.beforeReclaim = undefined;
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  });

  it.runIf(process.platform !== "win32")(
    "keeps worker reclamation on the opened database after an alias retarget",
    async () => {
      const sessionKey = "agent:main:retargeted-reclamation";
      const sessionId = "retargeted-reclamation";
      const directory = tempDirs.make("reclamation-alias-");
      const originalPath = path.join(directory, "original.sqlite");
      const replacementPath = path.join(directory, "replacement.sqlite");
      const alias = path.join(directory, "alias.sqlite");
      await replaceSessionEntry(
        { sessionKey, storePath: originalPath },
        { sessionId, updatedAt: 1 },
      );
      // Close/checkpoint before copying so both files start with the same durable row and revision.
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      fs.copyFileSync(originalPath, replacementPath);
      fs.symlinkSync(originalPath, alias);
      expect(loadSessionEntry({ sessionKey, storePath: alias })).toMatchObject({ sessionId });
      archiveMaterializationHook.beforeReclaim = async () => {
        fs.unlinkSync(alias);
        fs.symlinkSync(replacementPath, alias);
      };

      await expect(
        deleteSessionEntryLifecycle({
          archiveTranscript: false,
          storePath: alias,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        }),
      ).resolves.toMatchObject({ deleted: true });
      expect(loadSessionEntry({ sessionKey, storePath: originalPath })).toBeUndefined();
      expect(loadSessionEntry({ sessionKey, storePath: replacementPath })).toMatchObject({
        sessionId,
      });
    },
  );

  it("preserves current and historical session data when authority closes before admission", async () => {
    const sessionKey = "agent:main:revoked-deletion";
    const sessionId = "revoked-deletion-current";
    const historicalSessionId = "revoked-deletion-history";
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: historicalSessionId, updatedAt: 1 },
    );
    await replaceTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }, [
      { type: "session", id: historicalSessionId, content: "retained history" },
    ]);
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 2 });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      { type: "session", id: sessionId, content: "retained current transcript" },
    ]);
    let authorized = true;
    archiveMaterializationHook.beforeReclaim = async () => {
      await Promise.resolve();
      authorized = false;
    };

    await expect(
      deleteSessionEntryLifecycle({
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
        commitGuard: () => {
          if (!authorized) {
            throw new Error("caller authority closed");
          }
        },
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      }),
    ).rejects.toThrow("caller authority closed");
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([
      expect.objectContaining({ id: sessionId, content: "retained current transcript" }),
    ]);
    await expect(
      loadTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }),
    ).resolves.toEqual([
      expect.objectContaining({ id: historicalSessionId, content: "retained history" }),
    ]);
  });

  it("fences new historical-generation work through the Worker commit", async () => {
    const sessionKey = "agent:main:historical-admission-race";
    const historicalSessionId = "historical-admission-previous";
    const currentSessionId = "historical-admission-current";
    const historicalEvent = {
      type: "session" as const,
      id: historicalSessionId,
      content: "historical admission transcript",
    };
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: historicalSessionId, updatedAt: 1 },
    );
    await replaceTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }, [
      historicalEvent,
    ]);
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: currentSessionId, updatedAt: 2 },
    );

    const materializationStarted = createDeferred();
    const materializationGate = createDeferred();
    archiveMaterializationHook.beforeMaterialize = async () => {
      materializationStarted.resolve();
      await materializationGate.promise;
    };

    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    await materializationStarted.promise;
    const assertHistoricalGenerationExists = async () => {
      const events = await loadTranscriptEvents({
        sessionKey,
        sessionId: historicalSessionId,
        storePath,
      });
      if (events.length === 0) {
        throw new Error("historical generation no longer exists");
      }
    };
    let admissionSettled = false;
    const admissionOutcome = beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, historicalSessionId],
      assertAllowed: assertHistoricalGenerationExists,
      revalidateAllowed: assertHistoricalGenerationExists,
    })
      .then((lease) => {
        lease.release();
        return "admitted";
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .finally(() => {
        admissionSettled = true;
      });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(admissionSettled).toBe(false);
    materializationGate.resolve();

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(admissionOutcome).resolves.toBe("historical generation no longer exists");
    await expect(
      loadTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }),
    ).resolves.toEqual([]);
  });
});

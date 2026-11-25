import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
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
const sessionKey = "agent:main:reclamation";
const sessionId = "current";
const historicalSessionId = "history";
let storePath: string;

beforeEach(() => {
  const tempDir = tempDirs.make("openclaw-session-reclamation-admission-race-");
  storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
});

afterEach(async () => {
  archiveMaterializationHook.beforeMaterialize = undefined;
  archiveMaterializationHook.beforeReclaim = undefined;
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

const scope = (pathname = storePath) => ({ sessionKey, storePath: pathname });
const transcript = (id: string) => ({ ...scope(), sessionId: id });
async function seed(id: string, updatedAt: number, content?: string) {
  await replaceSessionEntry(scope(), { sessionId: id, updatedAt });
  if (content !== undefined) {
    await replaceTranscriptEvents(transcript(id), [{ type: "session", id, content }]);
  }
}
function remove(options: Partial<Parameters<typeof deleteSessionEntryLifecycle>[0]> = {}) {
  return deleteSessionEntryLifecycle({
    archiveTranscript: false,
    storePath,
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    ...options,
  });
}

it.runIf(process.platform !== "win32")(
  "keeps worker reclamation on the opened database after an alias retarget",
  async () => {
    const directory = tempDirs.make("reclamation-alias-");
    const originalPath = path.join(directory, "original.sqlite");
    const replacementPath = path.join(directory, "replacement.sqlite");
    const alias = path.join(directory, "alias.sqlite");
    await replaceSessionEntry(scope(originalPath), { sessionId, updatedAt: 1 });
    // Close/checkpoint before copying so both files start with the same durable row and revision.
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    fs.copyFileSync(originalPath, replacementPath);
    fs.symlinkSync(originalPath, alias);
    expect(loadSessionEntry(scope(alias))).toMatchObject({ sessionId });
    archiveMaterializationHook.beforeReclaim = async () => {
      fs.unlinkSync(alias);
      fs.symlinkSync(replacementPath, alias);
    };

    await expect(remove({ storePath: alias })).resolves.toMatchObject({ deleted: true });
    expect(loadSessionEntry(scope(originalPath))).toBeUndefined();
    expect(loadSessionEntry(scope(replacementPath))).toMatchObject({ sessionId });
  },
);

it("preserves current and historical session data when authority closes before admission", async () => {
  await seed(historicalSessionId, 1, "retained history");
  await seed(sessionId, 2, "retained current transcript");
  let authorized = true;
  archiveMaterializationHook.beforeReclaim = async () => {
    await Promise.resolve();
    authorized = false;
  };

  await expect(
    remove({
      deleteTranscriptWithoutArchive: true,
      commitGuard: () => {
        if (!authorized) {
          throw new Error("caller authority closed");
        }
      },
    }),
  ).rejects.toThrow("caller authority closed");
  expect(loadSessionEntry(scope())).toMatchObject({ sessionId });
  await expect(loadTranscriptEvents(transcript(sessionId))).resolves.toEqual([
    expect.objectContaining({ id: sessionId, content: "retained current transcript" }),
  ]);
  await expect(loadTranscriptEvents(transcript(historicalSessionId))).resolves.toEqual([
    expect.objectContaining({ id: historicalSessionId, content: "retained history" }),
  ]);
});

it("fences new historical-generation work through the Worker commit", async () => {
  await seed(historicalSessionId, 1, "historical admission transcript");
  await seed(sessionId, 2);

  const materializationStarted = createDeferred();
  const materializationGate = createDeferred();
  archiveMaterializationHook.beforeMaterialize = async () => {
    materializationStarted.resolve();
    await materializationGate.promise;
  };

  const deletion = remove({ archiveTranscript: true });
  await materializationStarted.promise;
  const assertHistoricalGenerationExists = async () => {
    const events = await loadTranscriptEvents(transcript(historicalSessionId));
    if (events.length === 0) {
      throw new Error("historical generation no longer exists");
    }
  };
  let admissionSettled = false;
  const admissionOutcome = beginSessionEffect({
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

  await setImmediate();
  expect(admissionSettled).toBe(false);
  materializationGate.resolve();

  await expect(deletion).resolves.toMatchObject({ deleted: true });
  await expect(admissionOutcome).resolves.toBe("historical generation no longer exists");
  await expect(loadTranscriptEvents(transcript(historicalSessionId))).resolves.toEqual([]);
});

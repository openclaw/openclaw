import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionLifecycleArtifactsCore } from "./session-accessor.sqlite-artifact-cleanup.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import * as artifactPlanning from "./session-accessor.sqlite-lifecycle-artifacts.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import * as workerReaders from "./session-transcript-worker-readers.js";

let state: OpenClawTestState;
let storePath: string;
let options: { agentId: string; path: string; env: NodeJS.ProcessEnv };
const sessionKey = "agent:main:artifact-plan-victim";
const sessionId = "artifact-plan-victim";
const entry = { sessionId, updatedAt: 1 };
const event = { type: "metadata", runId: "artifact-plan-marker" };

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "artifact-planning-", layout: "state-only" });
  storePath = path.join(state.sessionsDir(), "sessions.json");
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  options = { agentId: "main", path: database.path, env: state.env };
  runOpenClawAgentWriteTransaction(
    (transaction) => writeSessionEntry(transaction, sessionKey, entry),
    options,
  );
  await replaceTranscriptEvents({ storePath, sessionKey, sessionId }, [event]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await state.cleanup();
});

it.each(["rejected", "admitted", "revoked", "referenced"] as const)(
  "preserves session state when a delayed artifact plan is %s",
  async (outcome) => {
    const reached = createDeferred();
    const release = createDeferred();
    let planReleased = false;
    const createReaders = workerReaders.createSessionHistoryWorkerReaders;
    vi.spyOn(workerReaders, "createSessionHistoryWorkerReaders").mockImplementation((run) =>
      createReaders(async (...args) => {
        const input = args[0]();
        const result = await run(...args);
        if (input.kind === "lifecycle-artifact-plan") {
          reached.resolve();
          await release.promise;
          planReleased = true;
          if (outcome === "rejected") {
            throw new Error("artifact planning rejected");
          }
        }
        return result;
      }),
    );
    const nativePlanning = vi
      .spyOn(artifactPlanning, "prepareSessionLifecycleArtifactCleanup")
      .mockRejectedValue(new Error("artifact planning ran on the calling thread"));
    const cleanup = cleanupSessionLifecycleArtifactsCore({
      storePath,
      sessionKeySegmentPrefix: "artifact-plan-",
      transcriptContentMarker: "artifact-plan-marker",
      orphanTranscriptMinAgeMs: 0,
      archiveRemovedEntryTranscripts: false,
    });
    const settled = cleanup.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
    let following: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(
        reached.promise,
        cleanup,
        "Artifact worker read was bypassed",
      );
      if (outcome === "admitted") {
        admission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey, sessionId],
          assertAllowed: () => {},
        });
      } else if (outcome === "revoked") {
        closing = closeOpenClawAgentDatabaseByPathAsync(options.path);
      } else if (outcome === "referenced") {
        runOpenClawAgentWriteTransaction(
          (database) =>
            writeSessionEntry(database, "agent:main:survivor", {
              sessionId: "survivor",
              previousSessionId: sessionId,
              updatedAt: 2,
            }),
          options,
        );
        let followingEntered = false;
        following = runExclusiveSqliteSessionWrite(
          options,
          async () => {
            expect(planReleased).toBe(true);
            followingEntered = true;
          },
          "session.transcript.batch",
        );
        expect(
          SQLITE_SESSION_WRITER_QUEUES.get(fs.realpathSync(options.path))?.pending,
        ).toHaveLength(1);
        expect(followingEntered).toBe(false);
      }
      release.resolve();
      if (outcome === "referenced") {
        expect(await settled).toEqual({
          value: { removedEntries: 1, archivedTranscriptArtifacts: 0 },
        });
        expect(
          loadSessionEntryReadOnly({ storePath, sessionKey: "agent:main:survivor" }),
        ).toMatchObject({
          previousSessionId: sessionId,
        });
      } else {
        const message = {
          rejected: "artifact planning rejected",
          admitted: "competing work is in flight",
          revoked: "revoked",
        }[outcome];
        expect(await settled).toMatchObject({
          error: { message: expect.stringContaining(message) },
        });
      }
      await closing;
      await following;
      expect(nativePlanning).not.toHaveBeenCalled();
      const retainedEntry = loadSessionEntryReadOnly({ storePath, sessionKey });
      if (outcome === "referenced") {
        expect(retainedEntry).toBeUndefined();
      } else {
        expect(retainedEntry).toMatchObject(entry);
      }
      expect(loadTranscriptEventsSync({ storePath, sessionId })).toEqual([event]);
    } finally {
      release.resolve();
      admission?.release();
      await settled;
      await closing;
      await following;
    }
  },
);

it("leaves a missing lifecycle store absent", async () => {
  const absent = { agentId: "missing", env: state.env };
  const databasePath = resolveOpenClawAgentSqlitePath(absent);
  expect(fs.existsSync(databasePath)).toBe(false);
  await expect(
    cleanupSessionLifecycleArtifactsCore({
      ...absent,
      storePath: path.join(state.sessionsDir("missing"), "sessions.json"),
      sessionKeySegmentPrefix: "artifact-plan-",
      transcriptContentMarker: "artifact-plan-marker",
      orphanTranscriptMinAgeMs: 0,
    }),
  ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
  expect(fs.existsSync(databasePath)).toBe(false);
});

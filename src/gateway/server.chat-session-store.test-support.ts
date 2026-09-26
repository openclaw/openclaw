import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import {
  releaseSessionTestDirectories,
  removeChatTestDirectory,
} from "./session-test-directories.test-support.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import { resetPersistentGatewaySessionStore } from "./test/persistent-session-store.test-support.js";

export type ChatSessionDirectoryOptions = { fresh?: boolean };

function createPersistentChatSessionStore() {
  const directories = createTempDirTracker();
  let directory: string;
  return {
    prepare(this: void) {
      directory = directories.make("openclaw-chat-persistent-");
    },
    directory(this: void) {
      return directory;
    },
    async reset(this: void) {
      await resetPersistentGatewaySessionStore(directory);
      testState.sessionStorePath = undefined;
    },
    async dispose(this: void) {
      await releaseSessionTestDirectories(directories.dirs);
      directories.cleanup();
    },
  };
}

export function createDirectChatSessionStoreFixture(
  freshDirectories: ReturnType<typeof createTempDirTracker>,
) {
  const persistentStore = createPersistentChatSessionStore();
  let persistentUsed = false;
  return {
    prepare: persistentStore.prepare,
    dispose: persistentStore.dispose,
    open(this: void, options?: ChatSessionDirectoryOptions) {
      // Filesystem and alternate-owner cases retain their own physical store.
      const sessionDir = options?.fresh
        ? freshDirectories.make("openclaw-gw-")
        : persistentStore.directory();
      persistentUsed ||= !options?.fresh;
      const storePath = path.join(sessionDir, "sessions.json");
      testState.sessionStorePath = storePath;
      return { sessionDir, storePath };
    },
    async reset(this: void) {
      if (persistentUsed) {
        await persistentStore.reset();
        persistentUsed = false;
      }
      await releaseSessionTestDirectories(freshDirectories.dirs);
    },
  };
}

export function createMainChatSessionStoreFixture(settleGatewayFixture: () => Promise<void>) {
  const persistentStore = createPersistentChatSessionStore();
  return {
    prepare: persistentStore.prepare,
    dispose: persistentStore.dispose,
    async run<T>(
      this: void,
      run: (dir: string) => Promise<T>,
      options?: { archivedAt?: number; sessionId?: string; freshStore?: boolean },
    ): Promise<T> {
      // openclaw-temp-dir: allow the cleanup regression verifies raw directory removal.
      const dir = options?.freshStore
        ? await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"))
        : persistentStore.directory();
      try {
        const sessionId = options?.sessionId ?? "sess-main";
        testState.sessionStorePath = path.join(dir, "sessions.json");
        await writeSessionStore({
          entries: {
            main: {
              sessionId,
              sessionFile: path.join(dir, `${sessionId}.jsonl`),
              updatedAt: Date.now(),
              ...(options?.archivedAt !== undefined ? { archivedAt: options.archivedAt } : {}),
            },
          },
        });
        return await run(dir);
      } finally {
        // Dispatch can outlive its RPC; keep its store selected until retained work settles.
        await settleGatewayFixture();
        if (options?.freshStore) {
          await removeChatTestDirectory(dir);
        } else {
          await persistentStore.reset();
        }
      }
    },
  };
}

export async function writeMainChatSessionTranscript(
  events: unknown[],
  sessionId = "sess-main",
  opts?: {
    agentId?: string;
    sessionKey?: string;
  },
) {
  const storePath = testState.sessionStorePath;
  if (!storePath) {
    throw new Error("session store path was not initialized");
  }
  // These fixtures always seed a complete fresh transcript. Replace it in one
  // transaction so large history cases do not pay one SQLite commit per event.
  const transcriptEvents = events
    .filter((event) => typeof event !== "string" || event.trim())
    .map((event) => (typeof event === "string" ? JSON.parse(event) : event)) as Parameters<
    typeof replaceTranscriptEvents
  >[1];
  await replaceTranscriptEvents(
    {
      agentId: opts?.agentId ?? "main",
      sessionId,
      sessionKey: opts?.sessionKey ?? "agent:main:main",
      storePath,
    },
    transcriptEvents,
  );
  // Oversized fixture transcripts take the deferred rebuild path; history
  // reads need the projection converged before the case under test runs.
  await waitForSessionTranscriptProjection({
    agentId: opts?.agentId ?? "main",
    sessionId,
    storePath,
  });
}

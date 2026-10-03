import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  ensureSessionEntrySync,
  replaceTranscriptEvents,
  rewindSessionToMessage,
  switchSessionBranch,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  cleanupManagedOutgoingMediaRecords,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} from "./managed-image-attachments.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
} from "./managed-image-record-store.js";
import { readSessionMessageCountAsync } from "./session-transcript-readers.js";

const ordering = vi.hoisted(() => ({ afterRead: undefined as (() => Promise<void>) | undefined }));
vi.mock("./session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-transcript-readers.js")>();
  return {
    ...actual,
    readSessionMessagesWithSourceAsync: async (
      ...args: Parameters<typeof actual.readSessionMessagesWithSourceAsync>
    ) => {
      const result = await actual.readSessionMessagesWithSourceAsync(...args);
      const hook = ordering.afterRead;
      ordering.afterRead = undefined;
      await hook?.();
      return result;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const timestamp = "2026-09-04T00:00:00.000Z";
let stateDir: string;
let savedEnv: ReturnType<typeof captureEnv>;

beforeEach(() => {
  savedEnv = captureEnv(["OPENCLAW_STATE_DIR"]);
  stateDir = fs.realpathSync(tempDirs.make("managed-branch-retention-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot({ agents: { list: [{ id: "main" }] } });
});

afterEach(async () => {
  ordering.afterRead = undefined;
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  savedEnv.restore();
});

describe("managed attachment branch retention", () => {
  it.each(["after transcript read", "after cleanup"] as const)(
    "retains media when the real branch owner restores it %s",
    async (switchAt) => {
      const sessionId = randomUUID();
      const sessionKey = `agent:main:${sessionId}`;
      const scope = {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
      };
      expect(ensureSessionEntrySync(scope, { sessionId, updatedAt: Date.now() })).toBe(true);
      const attachmentId = randomUUID();
      const mediaRoot = path.join(stateDir, "media");
      const mediaId = `${attachmentId}.png`;
      const originalPath = path.join(mediaRoot, MANAGED_OUTGOING_ORIGINALS_SUBDIR, mediaId);
      const body = Buffer.from("synthetic branch-owned media\n");
      fs.mkdirSync(path.dirname(originalPath), { recursive: true });
      fs.writeFileSync(originalPath, body);
      const url = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
      const messageId = "attached";
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: stateDir },
        {
          type: "message",
          id: "root",
          parentId: null,
          timestamp,
          message: { role: "assistant", content: "root" },
        },
        {
          type: "message",
          id: "user",
          parentId: "root",
          timestamp,
          message: { role: "user", content: "make an image" },
        },
        {
          type: "message",
          id: messageId,
          parentId: "user",
          timestamp,
          message: { role: "assistant", content: [{ type: "image", url, openUrl: url }] },
        },
      ]);
      await readSessionMessageCountAsync(scope);
      await insertManagedImageRecord(
        {
          attachmentId,
          sessionKey,
          agentId: "main",
          messageId,
          createdAt: timestamp,
          alt: "Synthetic branch attachment",
          original: {
            mediaRoot,
            mediaId,
            mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
            contentType: "image/png",
            width: 1,
            height: 1,
            sizeBytes: body.length,
            filename: "fixture.png",
          },
        },
        stateDir,
      );
      const download = () =>
        resolveManagedOutgoingMediaArtifactDownload({
          sessionKey,
          agentId: "main",
          stateDir,
          artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`,
        });
      expect(await download()).not.toBeNull();
      expect((await rewindSessionToMessage({ ...scope, entryId: "user" })).status).toBe("created");
      expect(await download()).toBeNull();
      let switched = false;
      const restoreBranch = async () => {
        expect((await switchSessionBranch({ ...scope, leafEntryId: messageId })).status).toBe(
          "created",
        );
        switched = true;
      };
      if (switchAt === "after transcript read") {
        ordering.afterRead = restoreBranch;
      }
      const result = await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey });
      expect(switched).toBe(switchAt === "after transcript read");
      expect(await readManagedImageRecord(attachmentId, stateDir)).not.toBeNull();
      expect(fs.readFileSync(originalPath)).toEqual(body);
      expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
      if (switchAt === "after cleanup") {
        expect(await download()).toBeNull();
        await restoreBranch();
      }
      expect(await download()).not.toBeNull();
    },
  );
});

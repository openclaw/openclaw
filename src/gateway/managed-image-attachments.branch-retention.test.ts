import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  ensureSessionEntrySync,
  rewindSessionToMessage,
  switchSessionBranch,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
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
  setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
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
  it.each(["after transcript read", "after cleanup", "between hidden-tail pages"] as const)(
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
      const branchMessages = Array.from(
        { length: switchAt === "after transcript read" ? 0 : 128 },
        (_, index) => ({
          id: `branch-${index}`,
          parentId: index === 0 ? "user" : `branch-${index - 1}`,
          timestamp,
          ...(switchAt === "between hidden-tail pages"
            ? { type: "custom", customType: "branch-control", data: {} }
            : { type: "message", message: { role: "assistant", content: "branch context" } }),
        }),
      );
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
        ...branchMessages,
        {
          type: "message",
          id: messageId,
          parentId: branchMessages.at(-1)?.id ?? "user",
          timestamp,
          message: { role: "assistant", content: [{ type: "image", url, openUrl: url }] },
        },
        ...Array.from(
          { length: switchAt === "between hidden-tail pages" ? 130 : 0 },
          (_, index) => ({
            type: "custom",
            id: `active-control-${index}`,
            parentId: index === 0 ? "user" : `active-control-${index - 1}`,
            timestamp,
            customType: "branch-control",
            data: {},
          }),
        ),
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
      if (switchAt !== "between hidden-tail pages") {
        expect(await download()).not.toBeNull();
        expect((await rewindSessionToMessage({ ...scope, entryId: "user" })).status).toBe(
          "created",
        );
      }
      expect(await download()).toBeNull();
      let switched = false;
      const restoreBranch = async () => {
        if (switchAt === "between hidden-tail pages") {
          const manager = await SessionManager.openAsync(scope, stateDir);
          await manager.appendLeafControlAsync({ targetId: messageId, appendParentId: messageId });
          expect(await readSessionMessageCountAsync(scope)).toBe(3);
        } else {
          expect((await switchSessionBranch({ ...scope, leafEntryId: messageId })).status).toBe(
            "created",
          );
        }
        switched = true;
      };
      if (switchAt !== "after cleanup") {
        ordering.afterRead = restoreBranch;
      }
      const cleanup = cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey });
      if (switchAt === "between hidden-tail pages") {
        await expect(cleanup).rejects.toMatchObject({
          name: "SessionTranscriptProjectionUnavailableError",
          reason: "window-changed",
        });
      } else {
        expect(await cleanup).toEqual({
          deletedRecordCount: 0,
          deletedFileCount: 0,
          retainedCount: 1,
        });
      }
      expect(switched).toBe(switchAt !== "after cleanup");
      expect(await readManagedImageRecord(attachmentId, stateDir)).not.toBeNull();
      expect(fs.readFileSync(originalPath)).toEqual(body);
      if (switchAt === "after cleanup") {
        expect(await download()).toBeNull();
        await restoreBranch();
      }
      expect(await download()).not.toBeNull();
    },
  );
});

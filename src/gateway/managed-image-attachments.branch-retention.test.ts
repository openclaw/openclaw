import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  listSessionBranches,
  rewindSessionToMessage,
  switchSessionBranch,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  cleanupManagedOutgoingMediaRecords,
  resolveManagedOutgoingMediaArtifactDownload,
} from "./managed-image-attachments.js";
import {
  insertManagedImageRecord,
  listManagedImageRecordEntries,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
} from "./managed-image-record-store.js";
import { readSessionMessagesWithSourceAsync } from "./session-transcript-readers.js";
import { loadSessionEntryReadOnly } from "./session-utils.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

const agentId = "main";
const sessionKey = "agent:main:media-branch";
const sessionId = "media-branch-session";
const attachmentId = "3f5c9c0e-1f9a-4a2b-8b3d-5c7e9a1d2b4f";
const mediaId = "managed-branch.png";

let stateDir: string;
let mediaRoot: string;
let originalPath: string;

function mediaUrl(): string {
  return `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
}

async function seedSessionWithManagedImage() {
  const scope = { agentId, env: process.env, sessionId, sessionKey };
  await upsertSessionEntry(scope, { sessionId, updatedAt: Date.now() });
  await appendTranscriptEvent(scope, {
    type: "session",
    id: sessionId,
    version: 3,
    timestamp: "2026-08-01T00:00:00.000Z",
  });
  const turns = [
    { id: "u1", parentId: null, message: { role: "user", content: "first prompt" } },
    { id: "a1", parentId: "u1", message: { role: "assistant", content: "first answer" } },
    { id: "u2", parentId: "a1", message: { role: "user", content: "draw me a chart" } },
    {
      id: "a2",
      parentId: "u2",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "here is the chart" },
          { type: "image", url: mediaUrl(), openUrl: mediaUrl(), mimeType: "image/png" },
        ],
      },
    },
    { id: "u3", parentId: "a2", message: { role: "user", content: "third prompt" } },
    { id: "a3", parentId: "u3", message: { role: "assistant", content: "third answer" } },
  ];
  let offset = 1;
  for (const turn of turns) {
    await appendTranscriptMessage(scope, {
      eventId: turn.id,
      message: turn.message,
      now: Date.parse("2026-08-01T00:00:00.000Z") + offset * 1000,
      parentId: turn.parentId,
    });
    offset += 1;
  }
}

async function commitManagedRecord(messageId: string | null) {
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.writeFile(originalPath, Buffer.from("89504e470d0a1a0a", "hex"));
  insertManagedImageRecord(
    {
      attachmentId,
      sessionKey,
      agentId,
      messageId,
      createdAt: "2026-08-01T00:00:04.000Z",
      updatedAt: "2026-08-01T00:00:04.000Z",
      retentionClass: "history",
      alt: "chart",
      original: {
        mediaRoot,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        mediaId,
        contentType: "image/png",
        width: 8,
        height: 8,
        sizeBytes: 8,
        filename: mediaId,
      },
    },
    stateDir,
  );
}

async function readActiveMessages(): Promise<unknown[]> {
  const loaded = loadSessionEntryReadOnly(sessionKey, { agentId });
  const result = await readSessionMessagesWithSourceAsync(
    {
      agentId,
      sessionEntry: loaded.entry,
      sessionId: loaded.entry?.sessionId ?? sessionId,
      sessionKey,
      storePath: loaded.storePath,
    },
    { mode: "full", reason: "branch retention", allowResetArchiveFallback: true },
  );
  return result.messages;
}

async function pathExists(target: string): Promise<boolean> {
  return await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

async function rewindPastManagedImage(): Promise<string> {
  const rewind = await rewindSessionToMessage({
    agentId,
    env: process.env,
    entryId: "u2",
    sessionKey,
  });
  expect(rewind.status).toBe("created");
  const branches = await listSessionBranches({ agentId, env: process.env, sessionKey });
  if (branches.status !== "ok") {
    throw new Error(`branch listing failed: ${branches.status}`);
  }
  const inactive = branches.branches.find((branch) => !branch.active);
  expect(inactive?.messageCount).toBe(6);
  return inactive?.leafEntryId ?? "a3";
}

describe("managed outgoing media retention across transcript branches", () => {
  beforeEach(async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "managed-media-branch-"));
    mediaRoot = path.join(stateDir, "media");
    originalPath = path.join(mediaRoot, MANAGED_OUTGOING_ORIGINALS_SUBDIR, mediaId);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await seedSessionWithManagedImage();
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("retains media referenced only by an inactive branch after a rewind", async () => {
    await commitManagedRecord("a2");
    const restorableLeaf = await rewindPastManagedImage();

    const result = await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey, agentId });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(listManagedImageRecordEntries({ stateDir })).toHaveLength(1);
    expect(await pathExists(originalPath)).toBe(true);

    const restored = await switchSessionBranch({
      agentId,
      env: process.env,
      leafEntryId: restorableLeaf,
      sessionKey,
    });
    expect(restored.status).toBe("created");
    const messages = await readActiveMessages();
    expect(messages).toHaveLength(6);
    expect(JSON.stringify(messages)).toContain(`${attachmentId}/full`);
    expect(await pathExists(originalPath)).toBe(true);
  });

  it("resolves an artifact download for media on an inactive branch", async () => {
    await commitManagedRecord("a2");
    await rewindPastManagedImage();

    await expect(
      resolveManagedOutgoingMediaArtifactDownload({
        sessionKey,
        artifactId: `artifact_managed_image_${attachmentId}`,
        stateDir,
      }),
    ).resolves.not.toBeNull();
  });

  it("still deletes media whose message is absent from every branch", async () => {
    await commitManagedRecord("missing-message");

    const result = await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey, agentId });

    expect(result).toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
    expect(listManagedImageRecordEntries({ stateDir })).toHaveLength(0);
    expect(await pathExists(originalPath)).toBe(false);
  });
});

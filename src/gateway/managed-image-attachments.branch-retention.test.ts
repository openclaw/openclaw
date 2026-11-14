import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  ensureSessionEntrySync,
  rewindSessionToMessage,
  switchSessionBranch,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  cleanupManagedOutgoingMediaRecords,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} from "./managed-image-attachments.js";
import { createFixture } from "./managed-image-attachments.test-support.js";
import { readManagedImageRecord } from "./managed-image-record-store.js";
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

const timestamp = "2026-09-04T00:00:00.000Z";
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;

function message(id: string, parentId: string | null, content: unknown, role = "assistant") {
  return { type: "message", id, parentId, timestamp, message: { role, content } };
}
const control = { type: "custom", customType: "branch-control", data: {} };
function chain(prefix: string, count: number, fields: Record<string, unknown>) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    parentId: index === 0 ? "user" : `${prefix}-${index - 1}`,
    timestamp,
    ...fields,
  }));
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "managed-branch-retention" });
  setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
});

afterEach(async () => {
  ordering.afterRead = undefined;
  await state.cleanup();
});

describe("managed attachment branch retention", () => {
  it.each(["after transcript read", "after cleanup", "between hidden-tail pages"] as const)(
    "retains media when the real branch owner restores it %s",
    async (switchAt) => {
      const { stateDir } = state;
      const sessionId = randomUUID();
      const sessionKey = `agent:main:${sessionId}`;
      const scope = {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
      };
      expect(ensureSessionEntrySync(scope, { sessionId, updatedAt: Date.now() })).toBe(true);
      const body = Buffer.from("synthetic branch-owned media\n");
      const messageId = "attached";
      const { attachmentId, originalPath } = await createFixture(stateDir, {
        attachmentId: randomUUID(),
        sessionKey,
        agentId: "main",
        messageId,
        createdAt: timestamp,
        body,
      });
      const url = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
      const branchMessages = chain(
        "branch",
        switchAt === "after transcript read" ? 0 : 128,
        switchAt === "between hidden-tail pages"
          ? control
          : { type: "message", message: { role: "assistant", content: "branch context" } },
      );
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: stateDir },
        message("root", null, "root"),
        message("user", "root", "make an image", "user"),
        ...branchMessages,
        message(messageId, branchMessages.at(-1)?.id ?? "user", [
          { type: "image", url, openUrl: url },
        ]),
        ...chain("active-control", switchAt === "between hidden-tail pages" ? 130 : 0, control),
      ]);
      await readSessionMessageCountAsync(scope);
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
      // Indexed membership finishes before the branch switch even when unrelated controls
      // would have forced the old full scan to fetch another page.
      await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey });
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

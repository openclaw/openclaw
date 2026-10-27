import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTranscriptWriteSequence } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { getReplyOperationSessionReader } from "../../sessions/session-controller.session-reader.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { initSessionState } from "./session.js";
import { writeSessionStore } from "./test/session.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-thread-mixed-case-");

afterEach(() => {
  vi.restoreAllMocks();
});

const header = (id: string, cwd: string, timestamp = "2026-06-15T00:00:00.000Z") => ({
  type: "session",
  version: 3,
  id,
  timestamp,
  cwd,
});

const messageEvent = (id: string, parentId: string | null, role: string, content: unknown) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-06-15T00:00:01.000Z",
  message: { role, content },
});

async function seedParent(
  storePath: string,
  parentSessionKey: string,
  parentSessionId: string,
  root: string,
) {
  await writeSessionStore(storePath, {
    [parentSessionKey]: {
      sessionId: parentSessionId,
      updatedAt: Date.now(),
    },
  });
  await withTranscriptWriteSequence(
    { agentId: "main", sessionId: parentSessionId, sessionKey: parentSessionKey, storePath },
    (transcript) =>
      transcript.replaceEvents([
        header(parentSessionId, root),
        messageEvent("parent-user", null, "user", "Parent prompt"),
        messageEvent("parent-assistant", "parent-user", "assistant", "Parent reply"),
      ]),
  );
}

it("first turn in a mixed-case thread is admitted against the forked child (real fork)", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());

  const root = sessionDirs.make();
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");

  const parentSessionKey = "agent:main:rocketchat:channel:c1";
  // A channel plugin that preserves thread-id casing hands the SDK this source key.
  const sourceSessionKey = "agent:main:rocketchat:channel:c1:thread:8p7pGpezBfxCxMg7p";
  const canonicalSessionKey = "agent:main:rocketchat:channel:c1:thread:8p7pgpezbfxcxmg7p";
  const parentSessionId = "parent-session";

  await seedParent(storePath, parentSessionKey, parentSessionId, root);
  await writeSessionStore(storePath, {
    [parentSessionKey]: {
      sessionId: parentSessionId,
      updatedAt: Date.now(),
    },
    // Existing thread row that was never forked, so initialization forks it.
    [sourceSessionKey]: {
      sessionId: "preseed-thread-session",
      updatedAt: Date.now(),
    },
  });

  const admission = await admitReplyTurn({
    agentId: "main",
    sessionKey: sourceSessionKey,
    sessionId: "preseed-thread-session",
    expectedSessionId: "preseed-thread-session",
    storePath,
    kind: "visible",
    resetTriggered: false,
  });
  expect(admission.status).toBe("owned");
  if (admission.status !== "owned") {
    throw new Error(`expected an owned admission, received ${admission.status}`);
  }

  // A channel adapter hands dispatch a finalized inbound context; build it the same way.
  const ctx = finalizeInboundContext({
    Body: "Thread reply",
    CommandAuthorized: false,
    CommandSource: "text",
    Provider: "rocketchat",
    Surface: "rocketchat",
    SessionKey: sourceSessionKey,
    ParentSessionKey: parentSessionKey,
  });

  const result = await initSessionState({
    ctx,
    cfg: { session: { store: storePath } } as OpenClawConfig,
    commandAuthorized: false,
    replyOperation: admission.operation,
  });

  expect(result.sessionKey).toBe(canonicalSessionKey);
  expect(result.sessionEntry.forkedFromParent).toBe(true);
  expect(result.sessionEntry.sessionId).not.toBe("preseed-thread-session");

  const reader = getReplyOperationSessionReader(admission.operation);
  expect(reader).toBeDefined();
  const read = await reader!.readEntry(() => {});
  expect(read.entry.sessionId).toBe(result.sessionEntry.sessionId);
});

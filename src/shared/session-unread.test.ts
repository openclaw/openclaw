// Unread follows what a run added to the chat, through the real session writers.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { updateSessionStoreAfterAgentRun } from "../agents/command/session-store.js";
import {
  createRunResult,
  withTempSessionStore,
} from "../agents/command/session-store.test-support.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../agents/harness/transcript-visibility.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../agents/sessions/session-manager.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import {
  initSessionState,
  writeSessionStore,
} from "../auto-reply/reply/test/session.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { appendTranscriptEventSync } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { deriveSessionUnread } from "./session-unread.js";

const sessionDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:dashboard:parent";
const sessionId = "parent-session";

const user = (content: string, extra: Record<string, unknown> = {}) => ({
  role: "user",
  content,
  ...extra,
});
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-5.4",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  stopReason: "stop",
});

/** Runs one turn in a chat the person just read, then lets the run end write the session. */
async function runTurnAfterRead(messages: Record<string, unknown>[]) {
  setRuntimeConfigSnapshot({});
  const dir = sessionDirs.make("openclaw-unread-");
  const target = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(dir, "agent.sqlite"),
  };
  const readAt = Date.now() - 1_000;
  await upsertSessionEntryCore(target, {
    sessionId,
    createdAt: readAt - 1_000,
    updatedAt: readAt,
    lastActivityAt: readAt - 1_000,
    lastReadAt: readAt,
    snoozedUntil: readAt + 3_600_000,
    snoozedAt: readAt,
  });
  appendTranscriptEventSync(target, {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    cwd: dir,
    timestamp: new Date(readAt - 1_000).toISOString(),
  });
  const manager = SessionManager.open(target, dir);
  for (const message of messages) {
    manager.appendMessage({ timestamp: Date.now(), ...message } as never);
  }
  const entry = loadSessionEntryReadOnly(target)!;
  await updateSessionStoreAfterAgentRun({
    agentId: "main",
    agentDir: dir,
    cfg: {},
    sessionId,
    sessionKey,
    storePath: target.storePath,
    sessionStore: { [sessionKey]: entry },
    defaultProvider: "openai",
    defaultModel: "gpt-5.4",
    result: createRunResult({ sessionId, provider: "openai", model: "gpt-5.4" }),
  });
  return loadSessionEntryReadOnly(target);
}

describe("deriveSessionUnread", () => {
  it.each([
    {
      name: "a woken turn that ends in NO_REPLY",
      messages: [
        user("child finished", {
          provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        }),
        assistant("NO_REPLY"),
      ],
    },
    { name: "a quiet heartbeat", messages: [user(HEARTBEAT_PROMPT), assistant("HEARTBEAT_OK")] },
    {
      // The run writer hides a child's sessions_send turn; its plain reply stays private.
      name: "a parent answering its child's sessions_send",
      messages: [user("progress"), assistant("noted")].map((message) =>
        projectAgentHarnessTranscriptMessageForDisplay({
          hidden: false,
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: "agent:main:subagent:child",
            sourceRole: "subagent",
          },
          message: message as never,
        }),
      ),
    },
  ])("stays read and snoozed after $name", async ({ messages }) => {
    const entry = await runTurnAfterRead(messages);

    expect(deriveSessionUnread(entry)).toBe(false);
    expect(entry?.snoozedUntil).toBeDefined();
  });

  it("turns unread and wakes a snooze after a visible reply", async () => {
    const entry = await runTurnAfterRead([user(HEARTBEAT_PROMPT), assistant("Disk is 95% full.")]);

    expect(deriveSessionUnread(entry)).toBe(true);
    expect(entry?.snoozedUntil).toBeUndefined();
  });

  it("turns unread for an inbound channel message but not for an internal wake", async () => {
    const readEntry: SessionEntry = {
      sessionId,
      createdAt: 1,
      updatedAt: 1,
      lastInteractionAt: 5,
      lastActivityAt: 5,
      lastReadAt: 10,
    };
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = { session: { store: storePath } };
      const ctx = { Body: "hello", SessionKey: sessionKey, Provider: "telegram" };

      await writeSessionStore(storePath, { [sessionKey]: readEntry });
      const wake = await initSessionState({ ctx: { ...ctx, InternalTurnSource: "event" }, cfg });
      expect(deriveSessionUnread(wake.sessionEntry)).toBe(false);

      await writeSessionStore(storePath, { [sessionKey]: readEntry });
      const inbound = await initSessionState({ ctx, cfg });
      expect(deriveSessionUnread(inbound.sessionEntry)).toBe(true);
    });
  });
});

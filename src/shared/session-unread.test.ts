// Unread follows the rows a transcript append adds to the chat, through the real SQLite append owner.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../agents/harness/transcript-visibility.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../agents/sessions/session-manager.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { appendTranscriptEventSync } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { deriveSessionUnread } from "./session-unread.js";

const sessionDirs = useAutoCleanupTempDirTracker(afterEach);

/** A chat the person read just now; each case appends one run's rows after that read. */
async function createReadSession({ legacy = false } = {}) {
  setRuntimeConfigSnapshot({});
  const dir = sessionDirs.make("openclaw-unread-");
  const target = {
    agentId: "main",
    sessionId: "chat",
    sessionKey: "agent:main:dashboard:chat",
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  const readAt = Date.now() - 1_000;
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    ...(legacy ? {} : { createdAt: readAt - 1_000, lastReadAt: readAt }),
    updatedAt: readAt,
    lastActivityAt: readAt - 1_000,
    snoozedUntil: readAt + 3_600_000,
    snoozedAt: readAt,
  });
  appendTranscriptEventSync(target, {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: target.sessionId,
    cwd: dir,
    timestamp: new Date(readAt - 1_000).toISOString(),
  });
  const manager = SessionManager.open(target, dir);
  return {
    target,
    append: (...messages: Record<string, unknown>[]) => {
      for (const message of messages) {
        manager.appendMessage({ timestamp: Date.now(), ...message } as never);
      }
    },
    entry: () => loadSessionEntryReadOnly(target),
  };
}

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

describe("deriveSessionUnread from transcript content", () => {
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
      // The run writer marks a child's sessions_send turn hidden; its plain reply stays private.
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
  ])("stays read after $name", async ({ messages }) => {
    const session = await createReadSession();
    session.append(...messages);

    const entry = session.entry();
    expect(deriveSessionUnread(entry)).toBe(false);
    expect(entry?.snoozedUntil).toBeDefined();
  });

  it.each([
    { name: "a visible reply", messages: [user(HEARTBEAT_PROMPT), assistant("Disk is 95% full.")] },
    {
      name: "a channel message",
      messages: [user("are you there?", { provenance: { kind: "external_user" } })],
    },
  ])("turns unread and wakes a snooze after $name", async ({ messages }) => {
    const session = await createReadSession();
    session.append(...messages);

    const entry = session.entry();
    expect(deriveSessionUnread(entry)).toBe(true);
    expect(entry?.snoozedUntil).toBeUndefined();
  });

  it("wakes a snoozed legacy session that has no read baseline", async () => {
    const session = await createReadSession({ legacy: true });
    session.append(assistant("Disk is 95% full."));

    expect(session.entry()?.snoozedUntil).toBeUndefined();
  });

  it("keeps activity from a batched turn when the turn also writes session metadata", async () => {
    const session = await createReadSession();
    await persistSessionTranscriptTurn(session.target, {
      expectedSessionId: session.target.sessionId,
      messages: [
        { message: { ...user("ping"), timestamp: Date.now() } },
        { message: { ...assistant("pong"), timestamp: Date.now() } },
      ],
      sessionLifecyclePatch: { lastInteractionAt: Date.now() },
    });

    expect(deriveSessionUnread(session.entry())).toBe(true);
  });
});

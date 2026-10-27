import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectTextContentBlocks } from "../agents/content-blocks.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync as loadEvents,
} from "../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session-write.js";
import {
  appendRelayVoiceTranscript as appendRelay,
  createOrResumeClientVoiceSession as createVoiceSession,
} from "./client-voice-session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const agentId = "main";
const CONSULT_REPLY = "Two meetings.";
const QUESTION = "Calendar tomorrow?";

function readMessageTexts(scope: Parameters<typeof loadEvents>[0]): string[] {
  return loadEvents(scope).flatMap((event) => {
    const content = (event as { message?: { content?: unknown } } | null)?.message?.content;
    return typeof content === "string" ? [content] : collectTextContentBlocks(content);
  });
}

async function prepareConsultTurn(label: string) {
  const dir = tempDirs.make(`openclaw-${label}-`);
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  const storePath = path.join(dir, "sessions.sqlite");
  const sessionKey = `agent:${agentId}:${label}`;
  const sessionId = await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey, storePath });
  const scope = { agentId, sessionId, sessionKey, storePath };
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "earlier question", timestamp: 1 });
  const input = { role: "user" as const, content: QUESTION, timestamp: 2 };
  const { anchor } = manager.appendMessageWithTranscriptAnchor(input);
  if (!anchor) {
    throw new Error("missing current-turn anchor");
  }
  const appendConsultReply = () =>
    runWithSessionTranscriptReadFence({ ...anchor, logicalTurnId: label, role: "user" }, () =>
      SessionManager.openBounded(scope, { cwd: dir, maxBytes: 8192, maxEvents: 16 }).appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: CONSULT_REPLY }],
          timestamp: 5,
        }),
      ),
    );
  return { appendConsultReply, scope, sessionKey, storePath };
}

afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  envSnapshot.restore();
});

// openclaw#150204 family: the live call keeps transcribing while the consult runs.
it("keeps the voice transcript from failing an in-flight agent consult", async () => {
  const { appendConsultReply, scope, sessionKey, storePath } =
    await prepareConsultTurn("voice-consult-relay");
  const voiceSessionId = await createVoiceSession({
    agentId,
    sessionKey,
    origin: "relay",
    provider: "realtime",
  });
  const target = {
    agentId,
    sessionKey,
    sessionTarget: { sessionKey, storePath },
    voiceSessionId,
  };
  await appendRelay({ ...target, entryId: "utterance-1", role: "user", text: QUESTION });
  await appendRelay({ ...target, entryId: "filler-1", role: "assistant", text: "Checking." });
  expect(() => appendConsultReply()).not.toThrow();
  const messages = readMessageTexts(scope);
  expect(messages).toEqual(["earlier question", QUESTION, QUESTION, "Checking.", CONSULT_REPLY]);
});

// The exemption keys on the marker the voice writer stamps, not on the kind alone.
it.each([
  ["no-channel", { kind: "realtime_voice" }],
  ["foreign-channel", { kind: "realtime_voice", sourceChannel: "discord" }],
  ["foreign-kind", { kind: "typed_chat", sourceChannel: "talk" }],
] as const)(
  "still rejects a consult reply superseded by a %s user row",
  async (label, provenance) => {
    const { appendConsultReply, scope } = await prepareConsultTurn(`voice-consult-${label}`);
    await appendTranscriptMessage(scope, {
      eventId: `forged:${label}`,
      message: { role: "user", content: [{ type: "text", text: "new" }], timestamp: 3, provenance },
      now: 3,
    });

    expect(() => appendConsultReply()).toThrow("SQLite transcript changed while preparing rewrite");
    expect(readMessageTexts(scope)).not.toContain(CONSULT_REPLY);
  },
);

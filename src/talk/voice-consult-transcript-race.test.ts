import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session-write.js";
import {
  appendRelayVoiceTranscript,
  createOrResumeClientVoiceSession,
} from "./client-voice-session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const agentId = "main";
const CONSULT_REPLY = "Two meetings tomorrow.";

function readMessageTexts(scope: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): string[] {
  return loadTranscriptEventsSync(scope).flatMap((event) => {
    const message = (event as { message?: { content?: unknown } } | null)?.message;
    const content = message?.content;
    if (typeof content === "string") {
      return [content];
    }
    if (!Array.isArray(content)) {
      return [];
    }
    return content.flatMap((block) =>
      block && typeof block === "object" && "text" in block
        ? [String((block as { text: unknown }).text)]
        : [],
    );
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
  const admission = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "what is on the calendar tomorrow?",
    timestamp: 2,
  });
  const anchor = admission.anchor;
  if (!anchor) {
    throw new Error("missing current-turn anchor");
  }
  const appendConsultReply = () =>
    runWithSessionTranscriptReadFence({ ...anchor, logicalTurnId: label, role: "user" }, () =>
      SessionManager.openBounded(scope, {
        cwd: dir,
        maxBytes: 8192,
        maxEvents: 16,
      }).appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: CONSULT_REPLY }],
          timestamp: 5,
        }),
      ),
    );
  return { appendConsultReply, scope, sessionKey, storePath };
}

beforeEach(() => {
  envSnapshot.restore();
});

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
  const voiceSessionId = await createOrResumeClientVoiceSession({
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
  await appendRelayVoiceTranscript({
    ...target,
    entryId: "utterance-1",
    role: "user",
    text: "what is on the calendar tomorrow?",
  });
  await appendRelayVoiceTranscript({
    ...target,
    entryId: "filler-1",
    role: "assistant",
    text: "I'll check that request.",
  });

  expect(() => appendConsultReply()).not.toThrow();

  expect(readMessageTexts(scope)).toEqual([
    "earlier question",
    "what is on the calendar tomorrow?",
    "what is on the calendar tomorrow?",
    "I'll check that request.",
    CONSULT_REPLY,
  ]);
});

// The exemption keys on the marker the voice writer stamps, not on the kind alone.
it.each([
  { label: "no-channel", provenance: { kind: "realtime_voice" } },
  {
    label: "foreign-channel",
    provenance: { kind: "realtime_voice", sourceChannel: "discord" },
  },
  {
    label: "foreign-kind",
    provenance: { kind: "typed_chat", sourceChannel: "talk" },
  },
])(
  "still rejects a consult reply superseded by a $label user row",
  async ({ label, provenance }) => {
    const { appendConsultReply, scope } = await prepareConsultTurn(`voice-consult-${label}`);
    await appendTranscriptMessage(scope, {
      eventId: `forged:${label}`,
      message: {
        role: "user",
        content: [{ type: "text", text: "different question" }],
        timestamp: 3,
        provenance,
      },
      now: 3,
    });

    expect(() => appendConsultReply()).toThrow("SQLite transcript changed while preparing rewrite");
    expect(readMessageTexts(scope)).not.toContain(CONSULT_REPLY);
  },
);

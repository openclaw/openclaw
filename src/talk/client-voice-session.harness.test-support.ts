import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

type AppendSessionTranscriptTurn =
  (typeof import("../config/sessions/session-accessor.sqlite-transcript-turn.js"))["appendExpectedSessionTranscriptTurn"];

const sessionTurnMocks = vi.hoisted(() => ({
  actualAppendSessionTranscriptTurn: undefined as AppendSessionTranscriptTurn | undefined,
  appendExpectedSessionTranscriptTurn: vi.fn<AppendSessionTranscriptTurn>(),
}));
const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("../config/sessions/session-accessor.sqlite-transcript-turn.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../config/sessions/session-accessor.sqlite-transcript-turn.js")
    >();
  return {
    ...actual,
    appendExpectedSessionTranscriptTurn: sessionTurnMocks.appendExpectedSessionTranscriptTurn,
  };
});
// mock-isolation: Capture digest delivery without loading channel transports.
vi.mock("../channels/message/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/message/runtime.js")>();
  return {
    ...actual,
    sendDurableMessageBatchCore: sendDurableMessageBatch,
  };
});

export function useClientVoiceSessionHarness() {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempDir: string;
  const releaseHeldWrites: Array<() => void> = [];
  const tempDirs = useAutoCleanupTempDirTracker((removeTempDirs) => {
    afterEach(async () => {
      for (const release of releaseHeldWrites.splice(0)) {
        release();
      }
      clientVoiceSessionTesting.reset();
      try {
        await cleanupSessionStateForTest({ stateDir: tempDir });
      } finally {
        envSnapshot.restore();
        removeTempDirs();
      }
    });
  });

  beforeEach(async () => {
    tempDir = tempDirs.make("openclaw-voice-session-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    sendDurableMessageBatch.mockReset().mockResolvedValue({ status: "sent" });
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockReset();
    // The mock factory can remain unrun on a warm graph until the first append.
    const { appendExpectedSessionTranscriptTurn } = await vi.importActual<
      typeof import("../config/sessions/session-accessor.sqlite-transcript-turn.js")
    >("../config/sessions/session-accessor.sqlite-transcript-turn.js");
    sessionTurnMocks.actualAppendSessionTranscriptTurn = appendExpectedSessionTranscriptTurn;
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementation(
      appendExpectedSessionTranscriptTurn,
    );
  });

  return { releaseHeldWrites, sendDurableMessageBatch, sessionTurnMocks };
}

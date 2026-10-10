import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  authorizeObservedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
  readClientVoiceConfirmationReadiness,
} from "./client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "./client-voice-confirmation.test-support.js";
import {
  appendClientVoiceTranscript,
  createOrResumeClientVoiceSession,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const mocks = vi.hoisted(() => ({ beforeAppend: vi.fn(async () => {}) }));
vi.mock("../config/sessions/session-accessor.sqlite-transcript-turn.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../config/sessions/session-accessor.sqlite-transcript-turn.js")
    >();
  return {
    ...actual,
    appendExpectedSessionTranscriptTurn: async (
      ...args: Parameters<typeof actual.appendExpectedSessionTranscriptTurn>
    ) => {
      await mocks.beforeAppend();
      return actual.appendExpectedSessionTranscriptTurn(...args);
    },
  };
});
describe("voice confirmation transcript admission", () => {
  let state: OpenClawTestState;
  const sessionKey = "agent:main:main";
  let scope: { agentId: string; voiceSessionId: string };
  const append = (
    entryId: string,
    text: string,
    role: "user" | "assistant" = "user",
    timestamp?: number,
  ) =>
    appendClientVoiceTranscript({
      ...scope,
      sessionKey,
      sessionTarget: { sessionKey },
      entryId,
      text,
      role,
      timestamp,
    });
  const block = (runId: string) =>
    checkClientVoiceToolConfirmationPolicy({
      ...scope,
      runId,
      toolName: "message",
      toolParams: { action: "send", message: runId },
      now: Date.now() - 1,
    });
  async function holdWrite() {
    const entered = createDeferred();
    const release = createDeferred();
    mocks.beforeAppend.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const blocker = append("assistant", "Please confirm", "assistant");
    await entered.promise;
    return { blocker, release };
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "confirmation-transcript", applyEnv: true });
    mocks.beforeAppend.mockReset().mockResolvedValue(undefined);
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId: "confirmation-transcript", updatedAt: Date.now() },
    );
    scope = {
      agentId: "main",
      voiceSessionId: await createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
      }),
    };
  });
  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    await state.cleanup();
  });
  it("captures direct transcript approval before waiting behind another durable write", async () => {
    block("A");
    const { blocker, release } = await holdWrite();
    const affirmative = append("yes-A", "yes", "user", Date.now() + 60_000);
    block("B");
    release.resolve();
    await Promise.all([blocker, affirmative]);
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeUndefined();
    await append("yes-B", "yes");
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeDefined();
  });

  it("preserves a current transcript retry without using an old deduplicated yes for a new challenge", async () => {
    block("A");
    await append("yes-original", "yes");
    await append("yes-original", "yes");
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeDefined();
    block("B");
    await append("yes-original", "yes");
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeUndefined();
    await append("yes-new", "yes");
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeDefined();
  });

  it.each([false, true])(
    "keeps a queued refusal bound to its exact challenge, superseded=%s",
    async (superseded) => {
      block("A");
      const { blocker, release } = await holdWrite();
      const refusal = append("no-A", "no");
      if (superseded) {
        block("B");
      }
      const affirmative = append("yes-later", "yes");
      release.resolve();
      await Promise.all([blocker, refusal, affirmative]);
      if (superseded) {
        expect(authorizeObservedClientVoiceConfirmation(scope)).toBeDefined();
      } else {
        expect(authorizeObservedClientVoiceConfirmation(scope)).toBeUndefined();
        expect(
          readClientVoiceConfirmationReadiness(scope.agentId, scope.voiceSessionId),
        ).toBeUndefined();
      }
    },
  );
});

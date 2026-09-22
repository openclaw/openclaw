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
vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    appendTranscriptMessage: async (...args: Parameters<typeof actual.appendTranscriptMessage>) => {
      await mocks.beforeAppend();
      return actual.appendTranscriptMessage(...args);
    },
  };
});
async function seedSession(sessionKey: string): Promise<void> {
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    { sessionId: "confirmation-transcript", updatedAt: Date.now() },
  );
}
describe("voice confirmation transcript admission", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "confirmation-transcript", applyEnv: true });
    mocks.beforeAppend.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    await state.cleanup();
  });
  it("captures direct transcript approval before waiting behind another durable write", async () => {
    const sessionKey = "agent:main:main";
    await seedSession(sessionKey);
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const scope = { agentId: "main", voiceSessionId };
    const target = { ...scope, sessionKey, sessionTarget: { sessionKey } };
    checkClientVoiceToolConfirmationPolicy({
      ...scope,
      runId: "A",
      toolName: "message",
      toolParams: { action: "send", message: "A" },
      now: Date.now() - 1,
    });
    const entered = createDeferred();
    const release = createDeferred();
    mocks.beforeAppend.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const blocker = appendClientVoiceTranscript({
      ...target,
      entryId: "assistant",
      role: "assistant",
      text: "Please confirm",
    });
    await entered.promise;
    const affirmative = appendClientVoiceTranscript({
      ...target,
      entryId: "yes-A",
      role: "user",
      text: "yes",
      timestamp: Date.now() + 60_000,
    });
    checkClientVoiceToolConfirmationPolicy({
      ...scope,
      runId: "B",
      toolName: "message",
      toolParams: { action: "send", message: "B" },
      now: Date.now() - 1,
    });
    release.resolve();
    await Promise.all([blocker, affirmative]);
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeUndefined();
    await appendClientVoiceTranscript({ ...target, entryId: "yes-B", role: "user", text: "yes" });
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeDefined();
  });

  it("preserves a current transcript retry without using an old deduplicated yes for a new challenge", async () => {
    const sessionKey = "agent:main:main";
    await seedSession(sessionKey);
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const scope = { agentId: "main", voiceSessionId };
    const input = {
      ...scope,
      sessionKey,
      sessionTarget: { sessionKey },
      entryId: "yes-original",
      role: "user" as const,
      text: "yes",
    };
    checkClientVoiceToolConfirmationPolicy({
      ...scope,
      runId: "A",
      toolName: "message",
      toolParams: { action: "send", message: "A" },
      now: Date.now() - 1,
    });
    await appendClientVoiceTranscript(input);
    await appendClientVoiceTranscript(input);
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeDefined();
    checkClientVoiceToolConfirmationPolicy({
      ...scope,
      runId: "B",
      toolName: "message",
      toolParams: { action: "send", message: "B" },
      now: Date.now() - 1,
    });
    await appendClientVoiceTranscript(input);
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeUndefined();
    await appendClientVoiceTranscript({ ...input, entryId: "yes-new" });
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeDefined();
  });

  it.each([false, true])(
    "keeps a queued refusal bound to its exact challenge, superseded=%s",
    async (superseded) => {
      const sessionKey = "agent:main:main";
      await seedSession(sessionKey);
      const voiceSessionId = createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
      });
      const scope = { agentId: "main", voiceSessionId };
      const target = { ...scope, sessionKey, sessionTarget: { sessionKey } };
      const block = (runId: string) =>
        checkClientVoiceToolConfirmationPolicy({
          ...scope,
          runId,
          toolName: "message",
          toolParams: { action: "send", message: runId },
          now: Date.now() - 1,
        });
      block("A");
      const entered = createDeferred();
      const release = createDeferred();
      mocks.beforeAppend.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      const blocker = appendClientVoiceTranscript({
        ...target,
        entryId: "assistant",
        role: "assistant",
        text: "Please confirm",
      });
      await entered.promise;
      const refusal = appendClientVoiceTranscript({
        ...target,
        entryId: "no-A",
        role: "user",
        text: "no",
      });
      if (superseded) {
        block("B");
      }
      const affirmative = appendClientVoiceTranscript({
        ...target,
        entryId: "yes-later",
        role: "user",
        text: "yes",
      });
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

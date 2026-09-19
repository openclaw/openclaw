import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  authorizeObservedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
} from "../../../talk/client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "../../../talk/client-voice-confirmation.test-support.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceBridgeCreateRequest,
} from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import type { TalkAgentConsultLifecycleMethods } from "../client-agent-consult.types.js";
import { controlBridge, controlContext } from "../client-gateway-control.test-support.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createTalkRealtimeRelaySession, stopTalkRealtimeRelaySession } from "./index.js";
import { closeRelaySession } from "./operations.js";
import { relaySessions, type RelaySession } from "./state.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), steer: vi.fn() }));
vi.mock("../client-agent-consult.js", () => ({
  createTalkClientAgentConsultRunner: () => ({
    runPrompt: Object.assign(mocks.run, {
      adoptCompletionClaims: vi.fn(),
      claimAppend: vi.fn(() => true),
      claimFailureAppend: vi.fn(() => true),
      steer: mocks.steer,
    }),
    getToolAuthorityOverlay: vi.fn(),
  }),
}));

describe("native relay confirmation transcript admission", () => {
  let state: OpenClawTestState;
  let relaySessionId: string | undefined;
  let ownedRelay: RelaySession | undefined;
  const connId = "relay-confirmation-client";

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "relay-confirmation", applyEnv: true });
    await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
    mocks.run.mockReset().mockResolvedValue({ text: "Read result." });
    mocks.steer.mockReset().mockResolvedValue({ text: "Read result." });
  });

  afterEach(async () => {
    if (ownedRelay) {
      await closeRelaySession(ownedRelay, "completed");
      ownedRelay = undefined;
    }
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    await state.cleanup();
  });

  function createHarness(challenge = true) {
    const cfg = { agents: { entries: { main: { default: true } } } };
    let request: RealtimeVoiceBridgeCreateRequest | undefined;
    const session = createTalkRealtimeRelaySession({
      cfg,
      context: controlContext(),
      connId,
      sessionTarget: prepareTalkSessionTarget(cfg, "agent:main:main"),
      controlSource: "delegation",
      provider: {
        id: "relay-confirmation",
        label: "Relay confirmation",
        isConfigured: () => true,
        createBridge: (options) => {
          request = options;
          return controlBridge();
        },
      },
      providerConfig: {},
      instructions: "Answer briefly.",
      tools: [],
    });
    relaySessionId = session.relaySessionId;
    const relay = relaySessions.get(relaySessionId);
    const run: (RealtimeVoiceAgentConsultRunner & TalkAgentConsultLifecycleMethods) | undefined =
      request?.runAgentConsult;
    if (!relay || !request || !run) {
      throw new Error("expected a registered native relay");
    }
    ownedRelay = relay;
    if (challenge) {
      expect(
        checkClientVoiceToolConfirmationPolicy({
          agentId: "main",
          voiceSessionId: relaySessionId,
          runId: "blocked-session-action",
          toolName: "sessions_spawn",
          toolCallId: "blocked-call",
          toolParams: { task: "Create a helper", label: "helper" },
          now: Date.now() - 1,
        }).allowed,
      ).toBe(false);
    }
    return { request, run, relay };
  }

  it.each(["run", "steer"] as const)(
    "waits for a future user transcript and durable append before native %s",
    async (mode) => {
      const h = createHarness();
      const persist = createDeferredCore();
      h.relay.voiceTranscriptQueue.enqueue(() => persist.promise);
      const abort = new AbortController();
      const callback = mode === "run" ? h.run : h.run.steer;
      if (!callback) {
        throw new Error("expected native steering");
      }
      mocks[mode].mockImplementation(async () => ({
        text: authorizeObservedClientVoiceConfirmation({
          agentId: "main",
          voiceSessionId: h.relay.id,
        })
          ? "Confirmed."
          : "Blocked.",
      }));
      const pending = callback({ prompt: "The user confirmed", signal: abort.signal });
      void pending.catch(() => {});
      try {
        await nextEventLoopTurn();
        expect(mocks[mode]).not.toHaveBeenCalled();
        h.request.onEvent?.({
          direction: "server",
          type: "response.created",
          responseId: "confirmation-prompt",
        });
        h.request.onTranscript?.("assistant", "Please confirm", true);
        h.request.onTranscript?.("user", "yes", true);
        await nextEventLoopTurn();
        expect(mocks[mode]).not.toHaveBeenCalled();
        persist.resolve();
        expect((await pending).text).toBe("Confirmed.");
        expect(mocks[mode]).toHaveBeenCalledOnce();
      } finally {
        persist.resolve();
        abort.abort();
        await pending.catch(() => {});
      }
    },
  );

  it("keeps ordinary native reads immediate when no confirmation is pending", async () => {
    const h = createHarness(false);
    expect((await h.run({ prompt: "Read current status" })).text).toBe("Read result.");
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("does not reuse a delayed yes after a newer partial begins", async () => {
    const h = createHarness();
    const persist = createDeferredCore();
    h.relay.voiceTranscriptQueue.enqueue(() => persist.promise);
    h.request.onTranscript?.("user", "yes", true);
    h.request.onTranscript?.("user", "no", false);
    const abort = new AbortController();
    const pending = h.run({ prompt: "Confirmed", signal: abort.signal });
    void pending.catch(() => {});
    try {
      persist.resolve();
      await h.relay.voiceTranscriptQueue.flush();
      await nextEventLoopTurn();
      expect(mocks.run).not.toHaveBeenCalled();
      h.request.onTranscript?.("user", "no", true);
      await pending;
      expect(
        authorizeObservedClientVoiceConfirmation({ agentId: "main", voiceSessionId: h.relay.id }),
      ).toBeUndefined();
      expect(mocks.run).toHaveBeenCalledOnce();
    } finally {
      persist.resolve();
      abort.abort();
      await pending.catch(() => {});
    }
  });

  it("settles an empty final without granting confirmation", async () => {
    const h = createHarness();
    const pending = h.run({ prompt: "Confirmed" });
    await nextEventLoopTurn();
    expect(mocks.run).not.toHaveBeenCalled();
    h.request.onTranscript?.("user", "", true);
    await pending;
    expect(
      authorizeObservedClientVoiceConfirmation({ agentId: "main", voiceSessionId: h.relay.id }),
    ).toBeUndefined();
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it.each(["before-final", "during-persistence", "before-challenge"] as const)(
    "does not let speech confirm a different challenge introduced %s",
    async (timing) => {
      const h = createHarness(timing !== "before-challenge");
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const persist = createDeferredCore();
      h.relay.voiceTranscriptQueue.enqueue(() => persist.promise);
      try {
        h.request.onTranscript?.("user", "ye", false);
        if (timing === "during-persistence") {
          h.request.onTranscript?.("user", "yes", true);
        }
        expect(
          checkClientVoiceToolConfirmationPolicy({
            agentId: "main",
            voiceSessionId: h.relay.id,
            runId: "replacement-action",
            toolName: "sessions_spawn",
            toolParams: { task: "Create a different helper", label: "different" },
          }).allowed,
        ).toBe(false);
        if (timing !== "during-persistence") {
          h.request.onTranscript?.("user", "yes", true);
        }
        now += 1;
        persist.resolve();
        await h.relay.voiceTranscriptQueue.flush();
        expect(
          authorizeObservedClientVoiceConfirmation({
            agentId: "main",
            voiceSessionId: h.relay.id,
          }),
        ).toBeUndefined();
      } finally {
        persist.resolve();
        clock.mockRestore();
      }
    },
  );

  it("closes a wait for future speech before invoking the native runner", async () => {
    const h = createHarness();
    const pending = h.run({ prompt: "The user confirmed" });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await stopTalkRealtimeRelaySession({ relaySessionId: h.relay.id, connId });
    relaySessionId = undefined;
    await rejected;
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

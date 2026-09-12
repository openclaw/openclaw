import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import * as clientVoiceSession from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../talk/provider-types.js";
import { makeBridge } from "../../talk/session-runtime.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { closeRelaySession } from "../talk-realtime-relay-operations.js";
import { drainingRelaySessions, relaySessions } from "../talk-realtime-relay-state.js";
import {
  createTalkRealtimeRelaySession,
  ensureTalkRealtimeRelayVoiceSession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "../talk-realtime-relay.js";
import { prepareTalkSessionTarget } from "../talk-session-target.js";

describe("realtime relay finalization", () => {
  let state: OpenClawTestState;
  let active: Parameters<typeof stopTalkRealtimeRelaySession>[0] | undefined;
  let finalization: ReturnType<typeof createDeferred<void>> | undefined;
  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "talk-relay-finalization",
      scenario: "minimal",
    });
  });
  afterEach(async () => {
    finalization?.resolve();
    finalization = undefined;
    if (active) {
      await stopTalkRealtimeRelaySession(active);
      active = undefined;
    }
    await Promise.allSettled(
      [...drainingRelaySessions].map(
        (session) => session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
      ),
    );
    vi.restoreAllMocks();
    clientVoiceSessionTesting.reset();
    await state.cleanup();
  });
  it.each([
    { providerAsync: true, fails: false },
    { providerAsync: true, fails: true },
    { providerAsync: false, fails: false },
    { providerAsync: false, fails: true },
  ])(
    "persists final transcripts before relay close resolves (async=$providerAsync, failure=$fails)",
    async ({ providerAsync, fails }) => {
      const completion = createDeferred();
      finalization = completion;
      const storePath = state.statePath("finalize-sessions.sqlite");
      const cfg: OpenClawConfig = { session: { store: storePath } };
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main", storePath },
        { sessionId: "relay-finalize", updatedAt: Date.now() },
      );
      const failure = new Error("provider cleanup failed");
      let request: RealtimeVoiceBridgeCreateRequest | undefined;
      const close = vi.fn(() => {
        if (providerAsync) {
          return completion.promise;
        }
        request?.onTranscript?.("user", "check my task", true);
        request?.onTranscript?.("assistant", "final words", true);
        if (fails) {
          throw failure;
        }
        return undefined;
      });
      if (!providerAsync) {
        const appendTranscript = clientVoiceSession.appendRelayVoiceTranscript;
        vi.spyOn(clientVoiceSession, "appendRelayVoiceTranscript").mockImplementation(
          async (...args) => {
            await completion.promise;
            return appendTranscript(...args);
          },
        );
      }
      const bridge = makeBridge({ close });
      const broadcastToConnIds = vi.fn();
      const warn = vi.fn();
      const session = createTalkRealtimeRelaySession({
        context: {
          broadcastToConnIds,
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => cfg,
          logGateway: { warn },
        } as never,
        connId: "conn-finalize",
        cfg,
        controlSource: "transcript",
        sessionTarget: prepareTalkSessionTarget(cfg, "agent:main:main"),
        provider: {
          id: "relay-test",
          label: "Relay Test",
          isConfigured: () => true,
          createBridge: (callbacks) => {
            request = callbacks;
            return bridge;
          },
        },
        providerConfig: {},
        instructions: "brief",
        tools: [],
        forceAgentConsultOnFinalTranscript: true,
      });
      request?.onReady?.();
      const target = { relaySessionId: session.relaySessionId, connId: "conn-finalize" };
      active = target;
      ensureTalkRealtimeRelayVoiceSession({ ...target, sessionKey: "agent:main:main" });
      const owned = relaySessions.get(session.relaySessionId);
      if (!owned) {
        throw new Error("Expected registered relay session");
      }
      active = undefined;
      const closing = stopTalkRealtimeRelaySession(target);
      expect(closeRelaySession(owned, "completed")).toBe(closing);
      let settled = false;
      void Promise.resolve(closing).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(() => sendTalkRealtimeRelayAudio({ ...target, audioBase64: "AQI=" })).toThrow(
        "Unknown realtime relay session",
      );
      if (providerAsync) {
        request?.onTranscript?.("user", "check my task", true);
        request?.onTranscript?.("assistant", "final words", true);
      }
      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
        "open",
      );
      const emitted = () => broadcastToConnIds.mock.calls.map(([, payload]) => payload);
      expect(emitted().some((payload) => payload.type === "close")).toBe(!providerAsync);
      expect(emitted().some((payload) => payload.type === "toolCall")).toBe(false);
      if (providerAsync) {
        if (!fails) {
          request?.onClose?.("error");
        }
        request?.onClose?.("completed");
      }
      if (fails) {
        if (providerAsync) {
          completion.reject(failure);
        } else {
          completion.resolve();
        }
        await expect(closing).rejects.toBe(failure);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
      } else {
        completion.resolve();
        await closing;
      }
      expect(close).toHaveBeenCalledOnce();
      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
        "closed",
      );
      expect(emitted().filter((payload) => payload.type === "close")).toEqual([
        expect.objectContaining({ reason: providerAsync || fails ? "error" : "completed" }),
      ]);
      request?.onTranscript?.("assistant", "stale words", true);
      const messages = readSessionTranscriptMessageEvents({
        agentId: "main",
        sessionId: "relay-finalize",
        storePath,
      });
      expect(messages.map(({ event }) => event)).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "check my task" }],
          }),
        }),
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "final words" }],
          }),
        }),
      ]);
    },
  );
});

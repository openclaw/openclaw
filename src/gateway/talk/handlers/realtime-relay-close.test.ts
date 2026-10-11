import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareClientVoiceSessionClose } from "../../../talk/client-voice-session-lifecycle.js";
import * as clientVoiceSession from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import { makeBridge } from "../../../talk/session-runtime.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  closeRelaySession,
  ensureTalkRealtimeRelayVoiceSession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "../relay/operations.js";
import { createTalkRealtimeRelaySession } from "../relay/session-create.js";
import { drainingRelaySessions, relaySessions } from "../relay/state.js";
import { prepareTalkSessionTarget } from "../session-target.js";

describe("realtime relay finalization", () => {
  let state: OpenClawTestState;
  let active: Parameters<typeof stopTalkRealtimeRelaySession>[0] | undefined;
  let finalization: ReturnType<typeof createDeferred<void>> | undefined;
  let successorStateDir: string | undefined;
  let persistence: ReturnType<typeof prepareClientVoiceSessionClose> | undefined;
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
    await persistence?.drain();
    persistence = undefined;
    clientVoiceSessionTesting.reset();
    if (successorStateDir) {
      await cleanupSessionStateForTest({
        stateDir: successorStateDir,
        rootPath: successorStateDir,
      });
      successorStateDir = undefined;
    }
    await state.cleanup();
  });
  it.each([
    { providerAsync: true, fails: false, changeState: false, createRecord: true },
    { providerAsync: true, fails: true, changeState: false, createRecord: true },
    { providerAsync: false, fails: false, changeState: false, createRecord: true },
    { providerAsync: false, fails: true, changeState: false, createRecord: true },
    { providerAsync: true, fails: false, changeState: true, createRecord: true },
    { providerAsync: true, fails: false, changeState: true, createRecord: false },
    { providerAsync: true, fails: false, changeState: true, createRecord: false, cold: true },
    {
      providerAsync: true,
      fails: false,
      changeState: true,
      createRecord: true,
      permitFails: true,
    },
    {
      providerAsync: true,
      fails: false,
      changeState: true,
      createRecord: false,
      cold: true,
      sourceFails: true,
    },
    {
      providerAsync: true,
      fails: false,
      changeState: true,
      createRecord: false,
      cold: true,
      silent: true,
    },
  ])(
    "settles relay close (async=$providerAsync, failure=$fails, changed state=$changeState, existing record=$createRecord, cold=$cold, silent=$silent, source failure=$sourceFails, permit failure=$permitFails)",
    async ({
      providerAsync,
      fails,
      changeState,
      createRecord,
      cold = false,
      silent = false,
      sourceFails = false,
      permitFails = false,
    }) => {
      const completion = createDeferred();
      finalization = completion;
      const storePath = state.statePath("finalize-sessions.sqlite");
      const cfg: OpenClawConfig = { session: { store: storePath } };
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main", storePath },
        { sessionId: "relay-finalize", updatedAt: Date.now() },
      );
      if (!createRecord && !cold) {
        // Gateway admission can create the agent database before the first voice record.
        await replaceSessionEntry(
          { agentId: "main", sessionKey: "agent:main:host" },
          { sessionId: "admitted-host", updatedAt: Date.now() },
        );
      }
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
      if (createRecord) {
        await ensureTalkRealtimeRelayVoiceSession({ ...target, sessionKey: "agent:main:main" });
      }
      if (cold) {
        expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }))).toBe(false);
      }
      if (sourceFails) {
        fs.mkdirSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), { recursive: true });
      }
      const owned = relaySessions.get(session.relaySessionId);
      if (!owned) {
        throw new Error("Expected registered relay session");
      }
      active = undefined;
      if (permitFails) {
        persistence = prepareClientVoiceSessionClose();
        persistence.beginClose();
      }
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
      expect(close).toHaveBeenCalledOnce();
      expect(() => sendTalkRealtimeRelayAudio({ ...target, audioBase64: "AQI=" })).toThrow(
        "Unknown realtime relay session",
      );
      if (providerAsync) {
        const env = captureEnv(["OPENCLAW_STATE_DIR"]);
        try {
          if (changeState) {
            successorStateDir = state.statePath("successor");
            setTestEnvValue("OPENCLAW_STATE_DIR", successorStateDir);
          }
          if (!silent) {
            request?.onTranscript?.("user", "check my task", true);
            request?.onTranscript?.("assistant", "final words", true);
          }
        } finally {
          env.restore();
        }
      }
      if (!sourceFails && !silent) {
        if (!permitFails) {
          await owned.voiceSessionCreation;
        }
        expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
          "open",
        );
      }
      const emitted = () => broadcastToConnIds.mock.calls.map(([, payload]) => payload);
      expect(emitted().some((payload) => payload.type === "close")).toBe(!providerAsync);
      expect(emitted().some((payload) => payload.type === "toolCall")).toBe(false);
      if (providerAsync) {
        if (!fails) {
          request?.onClose?.("error");
        }
        request?.onClose?.("completed");
      }
      if (sourceFails || permitFails) {
        completion.resolve();
        await expect(closing).rejects.toThrow(sourceFails ? "regular file" : "admission is closed");
      } else if (fails) {
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
      if (!sourceFails) {
        expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
          permitFails ? "open" : "closed",
        );
      }
      expect(emitted().filter((payload) => payload.type === "close")).toEqual([
        expect.objectContaining({ reason: providerAsync || fails ? "error" : "completed" }),
      ]);
      request?.onTranscript?.("assistant", "stale words", true);
      const messages = readSessionTranscriptMessageEvents({
        agentId: "main",
        sessionId: "relay-finalize",
        storePath,
      });
      expect(messages.map(({ event }) => event)).toEqual(
        silent || sourceFails || permitFails
          ? []
          : [
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
            ],
      );
      if (successorStateDir) {
        expect(
          fs.existsSync(
            resolveOpenClawAgentSqlitePath({
              agentId: "main",
              env: { ...state.env, OPENCLAW_STATE_DIR: successorStateDir },
            }),
          ),
        ).toBe(false);
      }
    },
  );
});

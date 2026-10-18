import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
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
import { makeBridge, makeVoiceProvider } from "../../../talk/session-runtime.test-support.js";
import { withEnv } from "../../../test-utils/env.js";
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
    await cleanupSessionStateForTest({ stateDir: successorStateDir });
    successorStateDir = undefined;
  }
  await state.cleanup();
});
it.each([
  {},
  { fails: true },
  { providerAsync: false },
  { providerAsync: false, fails: true },
  { changeState: true },
  { changeState: true, createRecord: false },
  { changeState: true, createRecord: false, cold: true },
  { changeState: true, permitFails: true },
  { changeState: true, createRecord: false, cold: true, sourceFails: true },
  { changeState: true, createRecord: false, cold: true, silent: true },
])(
  "settles realtime relay close with overrides %j",
  async ({
    providerAsync = true,
    fails = false,
    changeState = false,
    createRecord = true,
    cold = false,
    silent = false,
    sourceFails = false,
    permitFails = false,
  }) => {
    const completion = createDeferred();
    finalization = completion;
    const storePath = state.statePath("finalize-sessions.sqlite");
    const sessionKey = "agent:main:main";
    const agentDbPath = (env = process.env) =>
      resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const cfg: OpenClawConfig = { session: { store: storePath } };
    setRuntimeConfigSnapshot(cfg);
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
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
    const transcripts = [
      ["user", "check my task"],
      ["assistant", "final words"],
    ] as const;
    const finalTranscripts = () =>
      transcripts.forEach(([role, text]) => request?.onTranscript?.(role, text, true));
    const close = vi.fn(() => {
      if (providerAsync) {
        return completion.promise;
      }
      finalTranscripts();
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
    const broadcastToConnIds = vi.fn();
    const warn = vi.fn();
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds,
        getRuntimeConfig: () => cfg,
        logGateway: { warn },
      } as never,
      connId: "conn-finalize",
      cfg,
      controlSource: "transcript",
      sessionTarget: await prepareTalkSessionTarget(cfg, sessionKey),
      provider: makeVoiceProvider((callbacks) => {
        request = callbacks;
        return makeBridge({ close });
      }),
      providerConfig: {},
      instructions: "brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    request?.onReady?.();
    const target = { relaySessionId: session.relaySessionId, connId: "conn-finalize" };
    const recordStatus = () =>
      clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status;
    active = target;
    if (createRecord) {
      await ensureTalkRealtimeRelayVoiceSession({ ...target, sessionKey });
    }
    if (cold) {
      expect(fs.existsSync(agentDbPath())).toBe(false);
    }
    if (sourceFails) {
      fs.mkdirSync(agentDbPath(), { recursive: true });
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
    const settled = vi.fn();
    void Promise.resolve(closing).then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(() => sendTalkRealtimeRelayAudio({ ...target, audioBase64: "AQI=" })).toThrow(
      "Unknown realtime relay session",
    );
    if (providerAsync) {
      if (changeState) {
        successorStateDir = state.statePath("successor");
      }
      withEnv({ OPENCLAW_STATE_DIR: successorStateDir ?? process.env.OPENCLAW_STATE_DIR }, () => {
        if (!silent) {
          finalTranscripts();
        }
      });
    }
    if (!sourceFails && !silent) {
      if (!permitFails) {
        await owned.voiceSessionCreation;
      }
      expect(recordStatus()).toBe("open");
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
    if (fails && providerAsync && !sourceFails && !permitFails) {
      completion.reject(failure);
    } else {
      completion.resolve();
    }
    if (sourceFails || permitFails) {
      await expect(closing).rejects.toThrow(sourceFails ? "regular file" : "admission is closed");
    } else if (fails) {
      await expect(closing).rejects.toBe(failure);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
    } else {
      await closing;
    }
    expect(close).toHaveBeenCalledOnce();
    if (!sourceFails) {
      expect(recordStatus()).toBe(permitFails ? "open" : "closed");
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
        : transcripts.map(([role, text]) =>
            expect.objectContaining({
              message: expect.objectContaining({ role, content: [{ type: "text", text }] }),
            }),
          ),
    );
    if (successorStateDir) {
      expect(
        fs.existsSync(agentDbPath({ ...state.env, OPENCLAW_STATE_DIR: successorStateDir })),
      ).toBe(false);
    }
  },
);

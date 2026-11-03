import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createIdleRelayProvider, makeRelayTransport } from "./index.test-support.js";
import { closeRelaySession } from "./operations.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { relaySessions } from "./state.js";

const cfg = { agents: { entries: { main: {} } } };

describe("talk realtime relay continuous output", () => {
  let state: OpenClawTestState;
  const opened: string[] = [];

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "relay-continuous-output", applyEnv: true });
  });

  afterEach(async () => {
    for (const relaySessionId of opened.splice(0)) {
      const session = relaySessions.get(relaySessionId);
      if (session) {
        await closeRelaySession(session, "completed");
      }
    }
    await state.cleanup();
  });

  it.each(["audio", "transcript"] as const)(
    "claims a Talk turn for continuous provider %s before browser audio",
    async (output) => {
      let request: RealtimeVoiceBridgeCreateRequest | undefined;
      const broadcast = vi.fn();
      const { relaySessionId } = createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: broadcast, chatAbortControllers: new Map() } as never,
        connId: "conn-1",
        cfg,
        provider: createIdleRelayProvider((input) => {
          request = input;
          return makeRelayTransport({ outputAudioMode: "continuous" });
        }),
        providerConfig: {},
        controlSource: "transcript",
        instructions: "brief",
        tools: [],
        sessionTarget: await prepareTalkSessionTarget(cfg, "agent:main:main"),
      });
      opened.push(relaySessionId);
      if (output === "audio") {
        request?.onAudio(Buffer.from("greeting"));
      } else {
        request?.onTranscript?.("assistant", "Hello", false);
      }

      const payloads = broadcast.mock.calls.map((call) => call[1] as Record<string, unknown>);
      expect(payloads.filter((payload) => payload.type === "error")).toEqual([]);
      const turnId = relaySessions.get(relaySessionId)?.harness.talk.activeTurnId;
      expect(turnId).toEqual(expect.any(String));
      expect(payloads.find((payload) => payload.type === output)).toMatchObject({
        talkEvent: { turnId },
      });
    },
  );
});

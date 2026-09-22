import {
  TALK_VOICE_CHANGE_TIMEOUT_MS,
  type TalkVoiceSelection,
  type TalkVoiceSetResult,
} from "../../packages/gateway-protocol/src/schema/talk-voice.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

export type RealtimeVoiceSelectionInfo = Omit<TalkVoiceSelection, "voiceSessionId" | "sessionKey">;

export type RealtimeVoiceSelectionRequest = {
  assertCurrent: () => void;
  signal?: AbortSignal;
};

type VoiceSelectionOwner = {
  voiceSessionId: string;
  agentId: string;
  sessionKey: string;
  read: () => RealtimeVoiceSelectionInfo;
  changeVoice: (voice: string, request: RealtimeVoiceSelectionRequest) => Promise<void>;
  assertCurrent: () => void;
};

export type RealtimeVoiceSelectionHandle = {
  bindRun: (params: { runId: string; assertCurrent: () => void }) => () => void;
  unregister: () => void;
};

type VoiceSelectionRun = {
  owner: VoiceSelectionOwner;
  assertCurrent: () => void;
};

const runs = resolveGlobalMap<string, VoiceSelectionRun>(
  Symbol.for("openclaw.realtimeVoiceSelectionRuns"),
  "close-and-restart",
);

/** Channel transports keep their connection lifecycle and expose only the current call operation. */
export function registerRealtimeVoiceSelection(
  owner: VoiceSelectionOwner,
): RealtimeVoiceSelectionHandle {
  let active = true;
  let changing = false;
  const callAbort = new AbortController();
  const bindings = new Set<string>();
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Voice call is no longer active");
    }
    owner.assertCurrent();
  };
  const boundOwner: VoiceSelectionOwner = {
    ...owner,
    assertCurrent,
    read: () => {
      assertCurrent();
      const selection = owner.read();
      return { ...selection, voices: [...selection.voices] };
    },
    changeVoice: async (query, request) => {
      const signal = AbortSignal.any([
        callAbort.signal,
        AbortSignal.timeout(TALK_VOICE_CHANGE_TIMEOUT_MS),
        ...(request.signal ? [request.signal] : []),
      ]);
      const assertRequestCurrent = () => {
        signal.throwIfAborted();
        assertCurrent();
        request.assertCurrent();
      };
      assertRequestCurrent();
      if (changing) {
        throw new Error("A voice change is already in progress for this call");
      }
      const selection = owner.read();
      if (!selection.canChange) {
        throw new Error("This call cannot change voices");
      }
      const voice = selection.voices.find(
        (candidate) => candidate.toLowerCase() === query.trim().toLowerCase(),
      );
      if (!voice) {
        throw new Error("Voice is not in this call's catalog; list the available voices first");
      }
      if (voice === selection.voice) {
        return;
      }
      changing = true;
      try {
        await owner.changeVoice(voice, { assertCurrent: assertRequestCurrent, signal });
        assertRequestCurrent();
        if (owner.read().voice !== voice) {
          throw new Error("The replacement call did not apply the requested voice");
        }
      } finally {
        changing = false;
      }
    },
  };
  return {
    bindRun: ({ runId, assertCurrent: assertRunCurrent }) => {
      assertCurrent();
      assertRunCurrent();
      if (runs.has(runId)) {
        throw new Error("The agent run already belongs to a voice call");
      }
      const binding: VoiceSelectionRun = {
        owner: boundOwner,
        assertCurrent: () => {
          assertCurrent();
          assertRunCurrent();
          if (runs.get(runId) !== binding) {
            throw new Error("The agent no longer owns this voice call");
          }
        },
      };
      runs.set(runId, binding);
      bindings.add(runId);
      return () => {
        if (runs.get(runId) === binding) {
          runs.delete(runId);
        }
        bindings.delete(runId);
      };
    },
    unregister: () => {
      active = false;
      callAbort.abort(new Error("Voice call closed"));
      for (const runId of bindings) {
        if (runs.get(runId)?.owner === boundOwner) {
          runs.delete(runId);
        }
      }
      bindings.clear();
    },
  };
}

export function resolveRealtimeVoiceSelectionRun(runId: string) {
  const binding = runs.get(runId);
  if (!binding) {
    return undefined;
  }
  const { owner } = binding;
  const read = (): TalkVoiceSelection => {
    binding.assertCurrent();
    return {
      ...owner.read(),
      voiceSessionId: owner.voiceSessionId,
      sessionKey: owner.sessionKey,
    };
  };
  return {
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    voiceSessionId: owner.voiceSessionId,
    assertCurrent: binding.assertCurrent,
    read,
    changeVoice: async (
      voice: string,
      request: RealtimeVoiceSelectionRequest,
    ): Promise<TalkVoiceSetResult> => {
      const assertCurrent = () => {
        binding.assertCurrent();
        request.assertCurrent();
      };
      await owner.changeVoice(voice, { assertCurrent, signal: request.signal });
      assertCurrent();
      return { ...read(), status: "applied" };
    },
  };
}

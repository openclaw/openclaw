import { randomUUID } from "node:crypto";
import {
  TALK_VOICE_CHANGE_TIMEOUT_MS,
  type TalkVoiceChangeEvent,
  type TalkVoiceSelection,
  type TalkVoiceSetResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { registerTalkConnectionCleanup } from "./session-registry.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

type VoiceSession = {
  voiceSessionId: string;
  connId: string;
  sessionTarget: PreparedTalkSessionTarget;
  selection: Omit<TalkVoiceSelection, "voiceSessionId" | "sessionKey">;
  /** Exact provider route; private model identifiers never leave this owner. */
  launch: { provider: string; model?: string };
  providerReady: boolean;
};

type VoiceChange = {
  id: string;
  original: VoiceSession;
  voice: string;
  requesterConnId: string;
  assertCurrent: () => void;
  send: (event: TalkVoiceChangeEvent) => void;
  completion: ReturnType<typeof createDeferredCore<TalkVoiceSetResult>>;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
  replacement?: VoiceSession;
  clientReady: boolean;
};

const sessions = resolveGlobalMap<string, VoiceSession>(
  Symbol.for("openclaw.talkVoiceSelections"),
  "close-and-restart",
);
const changes = resolveGlobalMap<string, VoiceChange>(
  Symbol.for("openclaw.talkVoiceChanges"),
  (pending) => {
    for (const change of pending.values()) {
      cancelChange(change, new Error("Gateway closed during voice change"));
    }
  },
  "close-and-restart",
);

function sessionKey(session: Pick<VoiceSession, "connId" | "voiceSessionId" | "sessionTarget">) {
  return `${session.connId}\0${session.sessionTarget.agentId}\0${session.voiceSessionId}`;
}

export function readTalkVoiceSelection(session: VoiceSession): TalkVoiceSelection {
  return {
    ...session.selection,
    voices: [...session.selection.voices],
    voiceSessionId: session.voiceSessionId,
    sessionKey: session.sessionTarget.sessionKey,
  };
}

function event(change: VoiceChange, phase: TalkVoiceChangeEvent["phase"]): TalkVoiceChangeEvent {
  return {
    changeId: change.id,
    voiceSessionId: change.original.voiceSessionId,
    sessionKey: change.original.sessionTarget.sessionKey,
    voice: change.voice,
    phase,
  };
}

function releaseChange(change: VoiceChange) {
  changes.delete(change.id);
  clearTimeout(change.timer);
}

function cancelChange(change: VoiceChange, error: Error) {
  if (changes.get(change.id) !== change) {
    return;
  }
  releaseChange(change);
  change.completion.reject(error);
  try {
    change.send(event(change, "cancelled"));
  } catch {
    // A disconnected client cannot receive cancellation; the caller still gets the failure.
  }
}

function assertChangeCurrent(change: VoiceChange) {
  if (changes.get(change.id) !== change) {
    throw new Error("Voice change is no longer active");
  }
  try {
    change.assertCurrent();
  } catch (error) {
    cancelChange(change, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

function assertReplacementTarget(change: VoiceChange, target: PreparedTalkSessionTarget) {
  const original = change.original.sessionTarget;
  if (
    target.agentId !== original.agentId ||
    target.canonicalKey !== original.canonicalKey ||
    target.storePath !== original.storePath
  ) {
    const error = new Error("Voice replacement must retain its original chat and storage target");
    cancelChange(change, error);
    throw error;
  }
}

function finishIfReady(change: VoiceChange) {
  const replacement = change.replacement;
  if (
    !replacement ||
    !change.clientReady ||
    !replacement.providerReady ||
    sessions.get(sessionKey(change.original)) === change.original
  ) {
    return;
  }
  try {
    assertChangeCurrent(change);
    if (sessions.get(sessionKey(replacement)) !== replacement) {
      throw new Error("Replacement voice call is no longer active");
    }
    const result: TalkVoiceSetResult = {
      ...readTalkVoiceSelection(replacement),
      status: "applied",
    };
    releaseChange(change);
    change.completion.resolve(result);
  } catch (error) {
    cancelChange(change, error instanceof Error ? error : new Error(String(error)));
  }
}

function trackConnection(connId: string) {
  registerTalkConnectionCleanup(connId, "voice-selection", () => {
    for (const change of changes.values()) {
      if (change.original.connId === connId || change.requesterConnId === connId) {
        cancelChange(change, new Error("Client disconnected during voice change"));
      }
    }
    for (const [key, session] of sessions) {
      if (session.connId === connId) {
        sessions.delete(key);
      }
    }
  });
}

export function registerTalkVoiceSession(params: VoiceSession & { voiceChangeId?: string }) {
  const { voiceChangeId, ...session } = params;
  const change = voiceChangeId ? changes.get(voiceChangeId) : undefined;
  if (voiceChangeId) {
    if (!change || !change.claimed || change.replacement) {
      throw new Error("Voice replacement was not admitted");
    }
    assertChangeCurrent(change);
    assertReplacementTarget(change, session.sessionTarget);
    if (
      session.connId !== change.original.connId ||
      session.voiceSessionId === change.original.voiceSessionId ||
      session.launch.provider !== change.original.launch.provider ||
      session.launch.model !== change.original.launch.model ||
      session.selection.voice !== change.voice
    ) {
      throw new Error("Voice replacement does not match the requested call and voice");
    }
    change.replacement = session;
  }
  const key = sessionKey(session);
  sessions.set(key, session);
  trackConnection(session.connId);
  return () => {
    if (sessions.get(key) === session) {
      unregisterTalkVoiceSession(
        session.voiceSessionId,
        session.connId,
        session.sessionTarget.agentId,
      );
    }
  };
}

export function unregisterTalkVoiceSession(
  voiceSessionId: string,
  connId: string | undefined,
  agentId: string,
) {
  if (!connId) {
    return;
  }
  const key = `${connId}\0${agentId}\0${voiceSessionId}`;
  const session = sessions.get(key);
  sessions.delete(key);
  for (const change of changes.values()) {
    if (change.replacement === session && session) {
      cancelChange(change, new Error("Replacement voice call closed before it became ready"));
    } else if (change.original === session) {
      finishIfReady(change);
    }
  }
}

export function cancelTalkVoiceSessionChange(
  voiceSessionId: string,
  connId: string,
  agentId: string,
): void {
  const session = sessions.get(`${connId}\0${agentId}\0${voiceSessionId}`);
  if (!session) {
    return;
  }
  for (const change of changes.values()) {
    if (change.original === session || change.replacement === session) {
      cancelChange(change, new Error("Voice change cancelled because the call was stopped"));
    }
  }
}

export function markTalkVoiceSessionReady(
  voiceSessionId: string,
  connId: string | undefined,
  agentId: string,
) {
  const session = sessions.get(`${connId}\0${agentId}\0${voiceSessionId}`);
  if (!session) {
    return;
  }
  session.providerReady = true;
  for (const change of changes.values()) {
    if (change.replacement === session) {
      finishIfReady(change);
    }
  }
}

export function resolveTalkVoiceSession(
  target:
    | { kind: "client"; connId: string; voiceSessionId?: string; sessionKey?: string }
    | { kind: "run"; agentId: string; voiceSessionId: string; sessionKey: string },
) {
  const matching = [...sessions.values()].filter(
    (session) =>
      (target.kind === "client"
        ? session.connId === target.connId
        : session.sessionTarget.agentId === target.agentId) &&
      (!target.voiceSessionId || session.voiceSessionId === target.voiceSessionId) &&
      (!target.sessionKey ||
        target.sessionKey === session.sessionTarget.sessionKey ||
        target.sessionKey === session.sessionTarget.canonicalKey),
  );
  const session = matching[0];
  if (matching.length !== 1 || !session) {
    throw new Error(
      matching.length ? "Select one active voice call" : "No active voice call is available",
    );
  }
  return session;
}

export function requestTalkVoiceChange(params: {
  session: VoiceSession;
  voice: string;
  requesterConnId: string;
  assertCurrent: () => void;
  send: (event: TalkVoiceChangeEvent) => void;
}): Promise<TalkVoiceSetResult> {
  params.assertCurrent();
  const original = params.session;
  if (sessions.get(sessionKey(original)) !== original) {
    throw new Error("Voice call is no longer active");
  }
  if (!original.selection.canChange) {
    throw new Error("This client cannot change voices during a call");
  }
  const query = params.voice.trim().toLowerCase();
  const voice = original.selection.voices.find((candidate) => candidate.toLowerCase() === query);
  if (!voice) {
    throw new Error("Voice is not in this call's catalog; list the available voices first");
  }
  if (
    [...changes.values()].some(
      (change) => change.original === original || change.replacement === original,
    )
  ) {
    throw new Error("A voice change is already in progress for this call");
  }
  if (voice === original.selection.voice) {
    return Promise.resolve({ ...readTalkVoiceSelection(original), status: "applied" });
  }
  const completion = createDeferredCore<TalkVoiceSetResult>();
  const id = randomUUID();
  const change: VoiceChange = {
    id,
    original,
    voice,
    requesterConnId: params.requesterConnId,
    assertCurrent: params.assertCurrent,
    send: params.send,
    completion,
    timer: setTimeout(() => {
      cancelChange(change, new Error("Voice change timed out before the replacement connected"));
    }, TALK_VOICE_CHANGE_TIMEOUT_MS),
    claimed: false,
    clientReady: false,
  };
  change.timer.unref?.();
  changes.set(id, change);
  trackConnection(params.requesterConnId);
  try {
    params.assertCurrent();
    params.send(event(change, "requested"));
  } catch (error) {
    cancelChange(change, error instanceof Error ? error : new Error(String(error)));
  }
  return completion.promise;
}

export function prepareTalkVoiceReplacement(params: {
  voiceChangeId?: string;
  connId?: string;
  sessionKey?: string;
}) {
  if (!params.voiceChangeId) {
    return undefined;
  }
  const change = changes.get(params.voiceChangeId);
  if (
    !change ||
    change.claimed ||
    change.original.connId !== params.connId ||
    (params.sessionKey !== change.original.sessionTarget.sessionKey &&
      params.sessionKey !== change.original.sessionTarget.canonicalKey)
  ) {
    throw new Error("Voice change is not owned by this client and chat");
  }
  assertChangeCurrent(change);
  change.claimed = true;
  return {
    ...change.original.launch,
    voice: change.voice,
    assertCurrent: (target?: PreparedTalkSessionTarget) => {
      assertChangeCurrent(change);
      if (target) {
        assertReplacementTarget(change, target);
      }
    },
  };
}

export function isTalkVoiceSessionReplacing(
  voiceSessionId: string,
  connId: string | undefined,
  agentId: string,
) {
  const change = [...changes.values()].find(
    ({ original }) =>
      original.voiceSessionId === voiceSessionId &&
      original.connId === connId &&
      original.sessionTarget.agentId === agentId,
  );
  if (!change) {
    return false;
  }
  try {
    assertChangeCurrent(change);
    return true;
  } catch {
    return false;
  }
}

export async function completeTalkVoiceChange(params: {
  changeId: string;
  connId: string;
  voiceSessionId?: string;
  outcome: "ready" | "failed";
  error?: string;
}) {
  const change = changes.get(params.changeId);
  if (!change || change.original.connId !== params.connId) {
    throw new Error("Voice change is not owned by this client");
  }
  assertChangeCurrent(change);
  if (params.outcome === "failed") {
    cancelChange(change, new Error(params.error || "Replacement voice call failed"));
    return;
  }
  if (!change.replacement || params.voiceSessionId !== change.replacement.voiceSessionId) {
    throw new Error("Voice change does not own this replacement call");
  }
  change.clientReady = true;
  finishIfReady(change);
  await change.completion.promise;
}

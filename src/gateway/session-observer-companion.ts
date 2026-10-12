import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { flushSessionActivityAssistantNote } from "../agents/session-activity-notes.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SessionObserverCompanionSnapshot } from "./session-observer-contract.js";
import type { SessionObserverDeps, SessionObserverState } from "./session-observer-model.js";
import {
  isSameSessionObserverLifecycle,
  resolveSessionObserverDigestForLifecycle,
} from "./session-observer-model.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

export function createSessionObserverCompanionSnapshotReader(params: {
  getConfig: SessionObserverDeps["getConfig"];
  readSession: NonNullable<SessionObserverDeps["readSession"]>;
  states: Map<string, SessionObserverState>;
  retireObsolete: (scopeKey: string, session: SessionEntry | undefined) => void;
}) {
  const resolve = (sessionKey: string, selectedAgentId?: string) => {
    const cfg = params.getConfig();
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
    });
    const canonicalSessionKey = resolveStoredSessionKeyForAgentStore({
      cfg,
      agentId,
      sessionKey,
    });
    return { agentId, canonicalSessionKey };
  };
  const read = (
    { canonicalSessionKey, agentId }: ReturnType<typeof resolve>,
    session: SessionEntry | undefined,
  ): SessionObserverCompanionSnapshot => {
    const scopeKey = resolveSessionSubscriptionKey(canonicalSessionKey, agentId);
    params.retireObsolete(scopeKey, session);
    const state = params.states.get(scopeKey);
    if (state && isSameSessionObserverLifecycle(state, session)) {
      flushSessionActivityAssistantNote(state);
      return {
        agentId: state.agentId,
        runId: state.runId,
        ...(state.previousDigest ? { digest: state.previousDigest } : {}),
        notes: state.notes.map((note) => ({ sequence: note.sequence, text: note.text })),
      };
    }
    const digest = resolveSessionObserverDigestForLifecycle(session?.observerDigest, session);
    return {
      agentId,
      ...(digest?.runId ? { runId: digest.runId } : {}),
      ...(digest ? { digest } : {}),
      notes: [],
    };
  };
  return {
    resolve,
    read,
    readSync(this: void, sessionKey: string, selectedAgentId?: string) {
      const target = resolve(sessionKey, selectedAgentId);
      return read(target, params.readSession(target.canonicalSessionKey, target.agentId));
    },
  };
}

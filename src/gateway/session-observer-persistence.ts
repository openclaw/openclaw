import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionObserverDeps, SessionObserverState } from "./session-observer-model.js";

const PERSIST_INTERVAL_MS = 60_000;

type PersistDigest = NonNullable<SessionObserverDeps["persistDigest"]>;

export function createSessionObserverDigestPersister(params: {
  now: () => number;
  persistDigest: PersistDigest;
  stillCurrent: (runId: string, sessionKey: string, agentId: string) => () => boolean;
  onMissingEntry: (state: SessionObserverState) => void;
  onError: (state: SessionObserverState, error: unknown) => void;
}) {
  const preamblePersistedAt = new WeakMap<SessionObserverState, number>();
  return async (
    state: SessionObserverState,
    digest: SessionObserverDigest,
    final: boolean,
    kind: "model" | "preamble" = "model",
  ) => {
    const lastPersistedAt =
      kind === "preamble" ? preamblePersistedAt.get(state) : state.lastPersistedAt;
    const due =
      lastPersistedAt === undefined || params.now() - lastPersistedAt >= PERSIST_INTERVAL_MS;
    if (!final && !due) {
      return;
    }
    // The writer owns outcome reconciliation; a failed reply never authorizes replay.
    try {
      const accepted = await params.persistDigest({
        ...(state.reader ? { reader: state.reader } : {}),
        sessionKey: state.sessionKey,
        sessionId: state.sessionId,
        agentId: state.agentId,
        digest,
        stillCurrent: params.stillCurrent(state.runId, state.sessionKey, state.agentId),
      });
      if (accepted === null) {
        params.onMissingEntry(state);
      } else if (accepted) {
        if (kind === "preamble") {
          preamblePersistedAt.set(state, params.now());
        } else {
          state.lastPersistedAt = params.now();
        }
      }
    } catch (error) {
      params.onError(state, error);
    }
  };
}

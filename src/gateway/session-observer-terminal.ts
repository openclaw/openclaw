import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SessionObserverEvent } from "./session-observer-contract.js";
import {
  isSameSessionObserverLifecycle,
  synthesizeSessionObserverTerminalDigest,
  type DormantSessionObserverRun,
  type SessionObserverDeps,
  type SessionObserverRead,
  type SessionObserverState,
} from "./session-observer-model.js";
import type { createSessionObserverWork } from "./session-observer-work.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

/** Retire same-run live health even when terminal observation cannot run the model. */
export function createSessionObserverTerminalPublisher(params: {
  dormantRuns: Map<string, DormantSessionObserverRun>;
  readSession: (
    sessionKey: string,
    agentId: string,
  ) => SessionEntry | undefined | Promise<SessionEntry | undefined>;
  persistDigest: NonNullable<SessionObserverDeps["persistDigest"]>;
  now: () => number;
  work: Pick<ReturnType<typeof createSessionObserverWork>, "withCurrent" | "closing" | "resetting">;
  runStillCurrent: (runId: string, sessionKey: string, agentId: string) => () => boolean;
  broadcast: (digest: SessionObserverDigest, agentId: string) => void;
  onError: (runId: string, error: unknown) => void;
}) {
  return async (source: {
    event?: SessionObserverEvent;
    state?: SessionObserverState;
    reader?: SessionObserverRead;
  }) => {
    const runId = source.event?.runId ?? source.state?.runId;
    if (!runId) {
      return;
    }
    const dormant = params.dormantRuns.get(runId);
    const reader = source.state?.reader ?? dormant?.reader ?? source.reader;
    const sessionKey = source.event?.sessionKey ?? source.state?.sessionKey ?? dormant?.sessionKey;
    const agentId = source.event?.agentId ?? source.state?.agentId ?? dormant?.agentId;
    if (!sessionKey || !agentId) {
      return;
    }
    const stillCurrent = params.runStillCurrent(runId, sessionKey, agentId);
    if (!stillCurrent()) {
      return;
    }
    try {
      const digest = await synthesizeSessionObserverTerminalDigest({
        source,
        dormant,
        // Synthesis only prepares a write; its transaction revalidates the row before commit.
        readSession: reader ? () => reader.withRead((session) => session) : params.readSession,
        persistDigest: (input) => params.persistDigest({ ...input, ...(reader ? { reader } : {}) }),
        now: params.now,
        stillCurrent,
      });
      if (!digest) {
        return;
      }
      await params.work.withCurrent(reader, sessionKey, agentId, (session) => {
        if (
          !params.work.closing &&
          stillCurrent() &&
          !params.work.resetting.has(resolveSessionSubscriptionKey(sessionKey, agentId)) &&
          isSameSessionObserverLifecycle(digest, session)
        ) {
          params.broadcast(digest, agentId);
        }
      });
    } catch (error) {
      params.onError(runId, error);
    }
  };
}

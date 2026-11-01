import type { SessionsCompanionStateResult } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-runtime.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  createSessionCompanionAskRuntime,
  type SessionCompanionAskDeps,
} from "./session-companion-ask.js";
import {
  sessionCompanionScopePrefix,
  sessionCompanionThreadKey,
  type SessionCompanionThread,
} from "./session-companion-state.js";
import { onGatewaySessionReset } from "./session-reset-notifications.js";

/** `ownerId` names the requester whose private thread is addressed. */
type SessionCompanionTarget = { sessionKey: string; agentId: string; ownerId: string };

export type SessionCompanionService = {
  ask: ReturnType<typeof createSessionCompanionAskRuntime>["ask"];
  state: (target: SessionCompanionTarget) => SessionsCompanionStateResult;
  reset: (target: SessionCompanionTarget) => void;
  dispose: () => void;
};

type SessionCompanionDeps = SessionCompanionAskDeps & {
  scheduler: GatewayScheduler;
};

const SESSION_COMPANION_IDLE_TTL_MS = 2 * 60 * 60_000;
const SESSION_COMPANION_SWEEP_INTERVAL_MS = 10 * 60_000;

export function createSessionCompanion(deps: SessionCompanionDeps): SessionCompanionService {
  const { scheduler } = deps;
  const threads = new Map<string, SessionCompanionThread>();
  let disposed = false;
  const askRuntime = createSessionCompanionAskRuntime({
    ...deps,
    now: () => scheduler.now(),
    threads,
    isDisposed: () => disposed,
  });

  const resetThread = (key: string, cancellation: "backing-session-revoked" | "explicit-reset") => {
    askRuntime.cancel(key, cancellation);
    threads.delete(key);
  };
  // Session lifecycle changes retire every requester's thread for that session.
  const revokeSession = (
    sessionKey: string,
    agentId: string,
    matches: (thread: SessionCompanionThread | undefined) => boolean = () => true,
  ) => {
    const prefix = sessionCompanionScopePrefix(sessionKey, agentId);
    const keys = new Set([...threads.keys(), ...askRuntime.activeKeys()]);
    for (const key of keys) {
      if (key.startsWith(prefix) && matches(threads.get(key))) {
        resetThread(key, "backing-session-revoked");
      }
    }
  };

  const sweep = () => {
    const cutoff = scheduler.now() - SESSION_COMPANION_IDLE_TTL_MS;
    for (const [key, thread] of threads) {
      if (!thread.busy && thread.lastUsedAt <= cutoff) {
        threads.delete(key);
      }
    }
  };
  const sweepJob = scheduler.schedule({
    id: "session-companion-sweep",
    atMs: scheduler.now() + SESSION_COMPANION_SWEEP_INTERVAL_MS,
    everyMs: SESSION_COMPANION_SWEEP_INTERVAL_MS,
    phase: "maintenance",
    run: sweep,
  });
  const unsubscribeReset = onGatewaySessionReset((sessionKey, suppliedAgentId) => {
    let agentId = suppliedAgentId;
    try {
      agentId ??= resolveSessionAgentId({ sessionKey, config: deps.getConfig() });
    } catch {
      return;
    }
    revokeSession(sessionKey, agentId);
  });
  const unsubscribeIdentity = onSessionIdentityMutation((mutation) => {
    const previousSessionId = mutation.kind === "delete" ? mutation.previous.sessionId : undefined;
    if (!previousSessionId) {
      return;
    }
    for (const sessionKey of mutation.previous.sessionKeys) {
      // Replayed deletions must not retire a newer generation under the same scoped key.
      revokeSession(
        sessionKey,
        mutation.agentId,
        (thread) => thread?.context.sessionId === previousSessionId,
      );
    }
  });

  // Names the utility route an unpinned question uses, in the picker's provider/model form.
  const resolveDefaultModel = (agentId: string) => {
    const cfg = deps.getConfig();
    const modelRef = resolveUtilityModelRefForAgent({ cfg, agentId });
    const selection = modelRef
      ? resolveSimpleCompletionSelectionForAgent({ cfg, agentId, modelRef })
      : null;
    return selection ? { defaultModel: `${selection.provider}/${selection.modelId}` } : {};
  };

  return {
    ask: askRuntime.ask,
    state(target) {
      const agentId = target.agentId.trim();
      const key = sessionCompanionThreadKey(target.sessionKey.trim(), agentId, target.ownerId);
      const thread = threads.get(key);
      const defaults = resolveDefaultModel(agentId);
      if (!thread) {
        return { exchanges: [], ...defaults };
      }
      thread.lastUsedAt = scheduler.now();
      return {
        exchanges: thread.exchanges.map(({ question, answer, ts }) => ({ question, answer, ts })),
        ...defaults,
      };
    },
    reset(target) {
      const sessionKey = target.sessionKey.trim();
      const agentId = target.agentId.trim();
      if (sessionKey && agentId) {
        resetThread(
          sessionCompanionThreadKey(sessionKey, agentId, target.ownerId),
          "explicit-reset",
        );
      }
    },
    dispose() {
      disposed = true;
      sweepJob.cancel();
      unsubscribeReset();
      unsubscribeIdentity();
      askRuntime.dispose();
      threads.clear();
    },
  };
}

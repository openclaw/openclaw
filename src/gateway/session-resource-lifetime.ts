import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

/** Session identity only: callers retain their existing authorization and invocation guards. */
export async function captureGatewaySessionLifetime(sessionKey: string) {
  const context = getInProcessGatewayRequestContext();
  const projection = getSessionRowProjection(context);
  if (!context || !projection) {
    throw new Error("Session resource identity requires an active Gateway projection");
  }
  const agent = resolveRequestedSessionAgentId(context.getRuntimeConfig(), sessionKey);
  if (!agent.ok) {
    throw new Error(agent.error.message);
  }
  const query = { key: sessionKey, agentId: agent.agentId };
  const original = await withReadySessionRows(
    projection,
    () => [query],
    (read) => read.describe(query),
  );
  if (!original?.entry.sessionId) {
    throw new Error("Session resource identity requires an existing session");
  }
  const target = Object.freeze({
    agentId: original.agentId,
    sessionKey: original.key,
    sessionId: original.entry.sessionId,
    ...(original.entry.lifecycleRevision
      ? { lifecycleRevision: original.entry.lifecycleRevision }
      : {}),
  });
  const generation = original.generation;
  let retired = false;
  const assertCurrent = () => {
    if (
      retired ||
      getSessionRowProjection(context) !== projection ||
      original.generation !== generation ||
      original.entry?.sessionId !== target.sessionId ||
      original.entry?.lifecycleRevision !== target.lifecycleRevision ||
      !projection.isCurrent(original)
    ) {
      retired = true;
      throw new Error("The session resource belongs to a retired session lifetime");
    }
    if (
      !isIncognitoSessionKey(target.sessionKey) &&
      projection.sharingTargetState(query).status === "pending"
    ) {
      throw new Error("Session resource identity is refreshing; retry the operation");
    }
  };
  const retain = () => {
    assertCurrent();
    const controller = new AbortController();
    const releases: Array<() => void> = [];
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      for (const unsubscribe of releases.splice(0)) {
        unsubscribe();
      }
      controller.abort(new Error("Session resource lifetime borrow released"));
    };
    const check = () => {
      if (released) {
        return;
      }
      try {
        assertCurrent();
      } catch (error) {
        // An operation cannot cross uncertain identity facts. This retires the
        // borrow, not the shared resource; a fresh operation can retry preparation.
        controller.abort(error);
        release();
      }
    };
    releases.push(
      sessionChanges.subscribe((change) => {
        if (
          "all" in change ||
          ((!change.agentId || change.agentId === target.agentId) &&
            (change.sessionKey === target.sessionKey || change.sessionKey === sessionKey))
        ) {
          check();
        }
      }),
      // The projection publishes exact physical-owner generation changes before observers run.
      onSessionIdentityMutation(check),
    );
    check();
    return {
      signal: controller.signal,
      assertCurrent: () => {
        controller.signal.throwIfAborted();
        assertCurrent();
      },
      release,
    };
  };
  assertCurrent();
  return { target, assertCurrent, retain };
}

/**
 * PR-8 follow-up: gateway-side listener that persists the live plan
 * snapshot onto `SessionEntry.planMode.lastPlanSteps` after each
 * `update_plan` tool call. Lets the Control UI rebuild the live-plan
 * sidebar after a hard refresh — without this, `latestPlanMarkdown`
 * lives only in in-memory `@state()` and is lost on page reload.
 *
 * Design: subscribes to agent events with `stream === "plan"`, looks up
 * the run context (already populated by `update-plan-tool.ts` before
 * the emit), and writes the snapshot through the existing
 * `applySessionsPatchToStore` seam so the write respects the same
 * validation + broadcast pipeline as user-initiated patches.
 *
 * The listener is wired in `server-runtime-subscriptions.ts` alongside
 * the existing agent/heartbeat/transcript/lifecycle subscriptions.
 */
import { loadConfig } from "../config/io.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { getAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

const log = createSubsystemLogger("gateway/plan-snapshot-persister");

export function startPlanSnapshotPersister(params: {
  emitSessionsChanged?: (opts: { sessionKey: string; reason: string }) => void;
}): () => void {
  const unsubscribe = onAgentEvent((evt) => {
    if (evt.stream !== "plan") {
      return;
    }
    const sessionKey = evt.sessionKey;
    if (!sessionKey) {
      return;
    }
    const ctx = getAgentRunContext(evt.runId);
    const snapshot = ctx?.lastPlanSteps;
    if (!snapshot || snapshot.length === 0) {
      return;
    }
    // Fire-and-forget — the event handler itself is synchronous so the
    // emit path isn't blocked on disk I/O. A failure here loses
    // refresh-after-reload restoration for this update, but the live
    // stream still delivers the plan to open UI clients via the usual
    // event path.
    void persistSnapshot({
      sessionKey,
      snapshot,
      emitSessionsChanged: params.emitSessionsChanged,
    }).catch((err) => {
      log.warn(
        `plan snapshot persist failed: sessionKey=${sessionKey} runId=${evt.runId} err=${String(err)}`,
      );
    });
  });
  return unsubscribe;
}

async function persistSnapshot(params: {
  sessionKey: string;
  snapshot: ReadonlyArray<{ step: string; status: string; activeForm?: string }>;
  emitSessionsChanged?: (opts: { sessionKey: string; reason: string }) => void;
}) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: params.sessionKey });
  await updateSessionStore(target.storePath, async (store) => {
    return await applySessionsPatchToStore({
      cfg,
      store,
      storeKey: params.sessionKey,
      patch: {
        key: params.sessionKey,
        lastPlanSteps: params.snapshot.map((s) => ({
          step: s.step,
          status: s.status,
          ...(s.activeForm !== undefined ? { activeForm: s.activeForm } : {}),
        })),
      },
    });
  });
  params.emitSessionsChanged?.({ sessionKey: params.sessionKey, reason: "patch" });
}

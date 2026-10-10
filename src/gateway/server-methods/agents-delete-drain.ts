import { tryResolveAgentOperationAgentId } from "../../agents/agent-scope-config.js";
import { listActiveEmbeddedRunSessionIds } from "../../agents/embedded-agent-runner/active-run-projections.js";
import {
  captureEmbeddedRunDrainTarget,
  type EmbeddedRunDrainTarget,
} from "../../agents/embedded-agent-runner/runs.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { resolveActiveReplyOperationForSessionId } from "../../auto-reply/reply/reply-run-registry.registry.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionEntrySummariesInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentRunContext, listLiveAgentRunIds } from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { agentWorkAdmissionIdentity } from "../../sessions/session-agent-work-admission.js";
import {
  collectActiveAgentSessionWorkAdmissions,
  startAgentWorkAdmissionInterruption,
} from "../../sessions/session-lifecycle-admission.js";
import { chatRunBelongsToAgent } from "../chat-run-owner.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import {
  prepareSessionLifecycleDrain,
  type SessionLifecycleDrain,
} from "./sessions-lifecycle-drain.js";
import type { GatewayRequestContext } from "./types.js";

/** The deletion journal already owns ingress; session owners retain cancellation writes. */
export async function drainAgentDeletionRuns(
  agentId: string,
  cfg: OpenClawConfig,
  context: GatewayRequestContext,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const defaultAgentId = tryResolveAgentOperationAgentId(cfg);
  const admissions = collectActiveAgentSessionWorkAdmissions({ agentId });
  const admissionAgent = agentWorkAdmissionIdentity({ agentId });
  const embeddedRuns = new Map<string, EmbeddedRunDrainTarget>();
  const unkeyedRuns: EmbeddedRunDrainTarget[] = [];
  const targets = new Map<string, Parameters<typeof prepareSessionLifecycleDrain>[0]>();
  const add = (sessionKey: string, sessionId?: string, scope = storePath) => {
    const canonicalKey = resolveSessionStoreIdentity({ cfg, sessionKey, agentId }).canonicalKey;
    const keys = [...new Set([sessionKey, canonicalKey])];
    const scoped = [...admissions].find(
      ([admissionScope, identities]) =>
        !admissionScope.startsWith("agent:") &&
        (keys.some((key) => identities.has(key)) ||
          Boolean(sessionId && identities.has(sessionId))),
    );
    const selectedScope = scoped?.[0] ?? scope;
    const key = JSON.stringify([selectedScope, canonicalKey, sessionId]);
    const existing = targets.get(key);
    const sessionKeys = [...new Set([...keys, ...(existing?.sessionKeys ?? [])])];
    targets.set(key, {
      action: "delete",
      timeoutMs: null,
      authorize: assertCurrent,
      context,
      storePath: selectedScope,
      agentId,
      admissionAgent,
      defaultAgentId,
      sessionKey: canonicalKey,
      sessionKeys,
      sessionId,
      embeddedRun: sessionId ? (embeddedRuns.get(sessionId) ?? null) : null,
      lifecycleIdentities: sessionId ? [...sessionKeys, sessionId] : sessionKeys,
    });
  };
  const addOwned = (
    run: { agentId?: string; sessionKey?: string; sessionId?: string } | undefined,
  ) => {
    if (run?.sessionKey && chatRunBelongsToAgent({ ...run, defaultAgentId }, agentId)) {
      add(run.sessionKey, run.sessionId);
    }
  };
  const drains: SessionLifecycleDrain[] = [];
  try {
    // Capture runtime owners before any asynchronous inventory or cancellation can settle them.
    for (const sessionId of listActiveEmbeddedRunSessionIds()) {
      const embedded = captureEmbeddedRunDrainTarget(sessionId, { agentId, defaultAgentId });
      if (embedded) {
        embeddedRuns.set(sessionId, embedded);
      }
      addOwned(embedded);
      if (embedded && !embedded.sessionKey) {
        unkeyedRuns.push(embedded);
      }
      const reply = resolveActiveReplyOperationForSessionId(sessionId);
      if (reply) {
        addOwned({ agentId: reply.agentId, sessionKey: reply.key, sessionId: reply.sessionId });
      }
    }
    for (const run of context.chatAbortControllers.values()) {
      addOwned(run);
    }
    for (const runId of listLiveAgentRunIds()) {
      addOwned(getAgentRunContext(runId));
    }
    for (const [scope, identities] of admissions) {
      for (const identity of identities) {
        if (parseAgentSessionKey(identity)?.agentId === agentId) {
          add(identity, undefined, scope.startsWith("agent:") ? storePath : scope);
        }
      }
    }
    for (const { sessionKey, entry } of await readSessionEntrySummariesInWorker({
      agentId,
      storePath,
    })) {
      const owner = resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey);
      if (
        (parseAgentSessionKey(sessionKey)?.agentId ??
          (owner.kind === "none" ? agentId : owner.agentId)) === agentId
      ) {
        add(sessionKey, entry.sessionId);
      }
    }
    assertCurrent();
    const embedded = unkeyedRuns.map(async (run) => {
      assertCurrent();
      run.abort();
      return run.waitForEnd(null);
    });
    const sessions = [...targets.values()].map(async (target) => {
      const drain = await prepareSessionLifecycleDrain(target);
      drains.push(drain);
      if (drain.hasAuthoritativeWork()) {
        throw new Error(`Agent ${agentId} still has active work in ${target.sessionKey}`);
      }
    });
    const admitted = Promise.resolve().then(() => {
      assertCurrent();
      return startAgentWorkAdmissionInterruption({
        agentId,
        assertCurrent,
        reason: createAgentRunDirectAbortError(),
      }).released;
    });
    const settled = await Promise.allSettled([...sessions, admitted, ...embedded]);
    const failures = settled.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        `Agent ${agentId} deletion is still draining`,
      );
    }
    assertCurrent();
  } finally {
    for (const drain of drains) {
      drain.release();
    }
    for (const run of embeddedRuns.values()) {
      run.release();
    }
  }
}

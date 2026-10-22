import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";

export function createEmbeddedSessionFixture(parentKey: string, parentId: string) {
  function parentTarget() {
    return captureSessionTarget({
      storeScope: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
        agentId: "main",
      }),
      sessionKey: parentKey,
      incarnation: parentId,
      agentId: "main",
    });
  }

  async function seedEmbeddedSession(runId: string, profileId?: string) {
    const target = { agentId: "main", sessionKey: parentKey };
    await sessions.upsertSessionEntryCore(target, {
      sessionId: parentId,
      updatedAt: 1,
      createdActor: profileId ? { type: "human", source: "profile", id: profileId } : undefined,
    });
    await persistGatewaySessionLifecycleEvent({
      ...target,
      event: {
        runId,
        sessionId: parentId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        ts: 1_000,
        data: { phase: "start", startedAt: 1_000 },
      },
    });
    return target;
  }
  return { target: parentTarget, seed: seedEmbeddedSession };
}

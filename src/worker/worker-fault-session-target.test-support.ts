import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { bindAgentToolExecutionLocation } from "../agents/agent-tool-metadata.js";
import { prepareCoreToolPolicy } from "../agents/prepared-tool-surface.js";
import type { BoundAgentRunSessionTarget } from "../agents/run-session-target.types.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { WorkerSessionTurnClaim } from "../gateway/worker-environments/placement-record.js";
import type { WorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import {
  bindWorkerTurnOwner,
  bindWorkerTurnToolSurface,
} from "../gateway/worker-environments/placement-turn-claim-events.js";
import { createWorkerGatewayToolRuntime } from "../gateway/worker-environments/worker-gateway-tool-runtime.js";
import { resolveWorkerTurnTranscriptTarget } from "../gateway/worker-environments/worker-turn-transcript-target.js";
import {
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import type { WorkerLaunchPlan } from "./launch-descriptor.js";
import { createWorkerPlacementTools } from "./worker-placement-tools.js";

export async function bindWorkerFixtureTurnSource(
  store: WorkerSessionPlacementStore,
  claim: WorkerSessionTurnClaim,
  target: BoundAgentRunSessionTarget,
) {
  const entry = loadSessionEntry(target);
  if (!entry || entry.sessionId !== claim.sessionId) {
    throw new Error("fault worker source is missing");
  }
  const sessionTarget = {
    ...target,
    expectedLifecycleRevision: entry.lifecycleRevision,
    expectedWriterRunId: entry.activeWriterRunId,
  };
  const assertSourceCurrent = () => {
    resolveWorkerTurnTranscriptTarget({ ...sessionTarget, sessionTarget });
  };
  const operationalRunInstance = createOperationalRunInstanceRef(claim.runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance, assertSourceCurrent);
  const lifetime = new AbortController();
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    lifetime.abort();
    // Placement settlement or fixture database close owns the durable claim.
    releaseAgentRunDelegatedAuthority(authority);
  };
  try {
    registerAgentRunContext(claim.runId, target, authority.claimId);
    await bindWorkerTurnOwner(
      store,
      claim,
      undefined,
      operationalRunInstance,
      sessionTarget,
      assertSourceCurrent,
    );
  } catch (error) {
    dispose();
    throw error;
  }
  let assignment: WorkerLaunchPlan["assignment"];
  bindWorkerTurnToolSurface(
    store,
    claim,
    createWorkerGatewayToolRuntime({
      assertCurrent: assertSourceCurrent,
      signal: lifetime.signal,
      prepare: async () => {
        const policy = prepareCoreToolPolicy({
          agentId: assignment.agentId,
          modelProvider: assignment.modelRef.provider,
          modelId: assignment.modelRef.model,
          ...(assignment.permissionMode
            ? {
                sessionPermissionPolicy: {
                  mode: assignment.permissionMode,
                  root: assignment.workspaceDir,
                },
              }
            : {}),
        });
        const tools = createWorkerPlacementTools({
          policy,
          cwd: assignment.workspaceDir,
          containmentRoot: assignment.workerContainmentRoot ?? assignment.workspaceDir,
          execAuthority: assignment.toolAuthority.exec,
          permissionMode: assignment.permissionMode,
          agentId: assignment.agentId,
          sessionKey: `worker:${claim.sessionId}`,
          sessionId: claim.sessionId,
          runId: claim.runId,
        }).filter((tool) =>
          assignment.toolAuthority.allowedToolNames.some((name) => name === tool.name),
        );
        for (const tool of tools) {
          bindAgentToolExecutionLocation(tool, { kind: "placement" });
        }
        return { tools, policy };
      },
    }),
  );
  return {
    operationalRunInstance,
    setToolAssignment(value: WorkerLaunchPlan["assignment"]) {
      assignment = value;
    },
    dispose,
  };
}

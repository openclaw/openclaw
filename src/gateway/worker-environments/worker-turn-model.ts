import type { WorkerInferenceModelRef } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  loadManifestModelCatalog,
  overlayConfiguredModelCatalog,
} from "../../agents/model-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { resolveProviderThinkingLevel } from "../../auto-reply/thinking.js";
import { resolveApprovedWorkerLocalModel, resolveApprovedWorkerModel } from "./inference-model.js";
import { boundedWorkerError } from "./worker-error.js";

export async function prepareWorkerTurnModel(params: {
  target: BoundAgentRunSessionTarget;
  modelRef: WorkerInferenceModelRef;
  runtimeSnapshot: PreparedModelRuntimeSnapshot;
  inferencePlacement: "gateway" | "worker";
  turn: Pick<SessionPlacementTurnParams, "abortSignal" | "config" | "workspaceDir" | "thinkLevel">;
  assertCurrent: () => void;
}) {
  const resolveModel =
    params.inferencePlacement === "worker"
      ? resolveApprovedWorkerLocalModel
      : resolveApprovedWorkerModel;
  const approved = await resolveModel({
    target: params.target,
    modelRef: params.modelRef,
    runtimeSnapshot: params.runtimeSnapshot,
    signal: params.turn.abortSignal,
    assertCurrent: params.assertCurrent,
  });
  if (!approved) {
    throw new Error("Worker model is not approved for this session");
  }
  if ("error" in approved) {
    throw new Error(boundedWorkerError(approved.error, 256));
  }
  const model = "prepared" in approved ? approved.prepared.model : approved.model;
  const reasoning = resolveProviderThinkingLevel({
    provider: params.modelRef.provider,
    model: params.modelRef.model,
    catalog:
      params.turn.thinkLevel === "ultra"
        ? overlayConfiguredModelCatalog({
            catalog: loadManifestModelCatalog({
              config: params.turn.config ?? {},
              workspaceDir: params.turn.workspaceDir,
            }),
            config: params.turn.config ?? {},
            workspaceDir: params.turn.workspaceDir,
          })
        : undefined,
    agentRuntime: "openclaw",
    level: params.turn.thinkLevel,
  });
  return {
    model,
    reasoning,
    transcriptPolicy: approved.transcriptPolicy,
    inference: "prepared" in approved ? approved : undefined,
  };
}

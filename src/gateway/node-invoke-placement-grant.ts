import type { ExecApprovalDecision } from "../infra/exec-approvals-core.js";
import type { NodeSession } from "./node-registry.js";
import type {
  PlacementStandingGrantMintSpec,
  PlacementStandingGrantRuntime,
} from "./operator-approval-placement-grants.js";

export type NodeInvokePlacementGrantAuthorization = {
  binding?: PlacementStandingGrantMintSpec;
};

type PlacementGrantResolution =
  | {
      kind: "granted";
      binding: PlacementStandingGrantMintSpec;
      approvalId: string;
    }
  | {
      kind: "prompt";
      binding: PlacementStandingGrantMintSpec | null;
      allowedDecisions: readonly ExecApprovalDecision[] | undefined;
    };

export type NodeInvokePlacementGrantOwner = {
  agentId: string;
  sessionKey: string;
  assertCurrent: (binding: PlacementStandingGrantMintSpec) => void;
};

function isBindingCurrentForOwner(
  owner: NodeInvokePlacementGrantOwner,
  binding: PlacementStandingGrantMintSpec,
): boolean {
  try {
    owner.assertCurrent(binding);
    return true;
  } catch {
    return false;
  }
}

async function resolveRuntimePlacementGrant(
  runtime: PlacementStandingGrantRuntime,
  input: Parameters<PlacementStandingGrantRuntime["resolveBinding"]>[0],
): Promise<{ binding: PlacementStandingGrantMintSpec | null; approvalId?: string }> {
  if (runtime.resolveAsync) {
    return runtime.resolveAsync(input);
  }
  // Released SDK callers may supply the original synchronous runtime contract.
  const binding = runtime.resolveBinding(input);
  const result = binding ? runtime.validate(binding) : undefined;
  return {
    binding,
    ...(result?.outcome === "consumed" ? { approvalId: result.grant.mintedByApprovalId } : {}),
  };
}

export async function resolveNodeInvokePlacementGrant(params: {
  runtime?: PlacementStandingGrantRuntime;
  requestedDecisions: readonly ExecApprovalDecision[] | undefined;
  owner?: NodeInvokePlacementGrantOwner;
  pluginId: string;
  command: string;
  approvalScope?: string;
  risk?: { level: "ordinary" | "high"; family: string };
  nodeSession: NodeSession;
}): Promise<PlacementGrantResolution> {
  const { owner, runtime, requestedDecisions } = params;
  const resolution =
    requestedDecisions?.includes("allow-always") === true &&
    owner &&
    params.approvalScope !== undefined &&
    params.risk?.level === "high" &&
    params.nodeSession.pairingGeneration &&
    runtime
      ? await resolveRuntimePlacementGrant(runtime, {
          pluginId: params.pluginId,
          command: params.command,
          approvalScope: params.approvalScope,
          agentId: owner.agentId,
          sessionKey: owner.sessionKey,
          nodeId: params.nodeSession.nodeId,
          pairingGeneration: params.nodeSession.pairingGeneration,
        })
      : { binding: null };
  const { binding } = resolution;
  const currentBinding =
    binding && owner && isBindingCurrentForOwner(owner, binding) ? binding : null;
  if (currentBinding && resolution.approvalId) {
    return {
      kind: "granted",
      binding: currentBinding,
      approvalId: resolution.approvalId,
    };
  }
  const allowedDecisions =
    requestedDecisions?.includes("allow-always") === true && !currentBinding
      ? requestedDecisions.filter((decision) => decision !== "allow-always")
      : requestedDecisions;
  return { kind: "prompt", binding: currentBinding, allowedDecisions };
}

export async function retainResolvedNodeInvokePlacementGrant(params: {
  runtime?: PlacementStandingGrantRuntime;
  decision: ExecApprovalDecision | null;
  binding: PlacementStandingGrantMintSpec | null;
  owner?: NodeInvokePlacementGrantOwner;
  authorization: NodeInvokePlacementGrantAuthorization;
}): Promise<boolean> {
  const { runtime, decision, owner, authorization } = params;
  const binding = params.binding ? { ...params.binding } : null;
  if (decision !== "allow-always" || !binding) {
    return true;
  }
  // The native runtime checks the durable parent once at the transport effect.
  // Custom released SDK runtimes keep their original validation contract.
  const result = runtime?.consumeAsync
    ? undefined
    : runtime?.validateAsync
      ? await runtime.validateAsync(binding)
      : runtime?.validate(binding);
  if (
    !owner ||
    !isBindingCurrentForOwner(owner, binding) ||
    (!runtime?.consumeAsync && result?.outcome !== "consumed")
  ) {
    return false;
  }
  authorization.binding = binding;
  return true;
}

export function consumeNodeInvokePlacementGrant(params: {
  runtime?: PlacementStandingGrantRuntime;
  authorization: NodeInvokePlacementGrantAuthorization;
}): "not-required" | "consumed" | "rejected" {
  if (!params.authorization.binding) {
    return "not-required";
  }
  try {
    return params.runtime?.consume(params.authorization.binding).outcome === "consumed"
      ? "consumed"
      : "rejected";
  } catch {
    return "rejected";
  }
}

export async function prepareNodeInvokePlacementGrant(params: {
  runtime?: PlacementStandingGrantRuntime;
  authorization: NodeInvokePlacementGrantAuthorization;
}): Promise<boolean> {
  const binding = params.authorization.binding;
  if (!binding || !params.runtime?.consumeAsync) {
    // Custom released SDK runtimes retain their synchronous final guard.
    return true;
  }
  try {
    return (await params.runtime.consumeAsync(binding)).outcome === "consumed";
  } catch {
    return false;
  }
}

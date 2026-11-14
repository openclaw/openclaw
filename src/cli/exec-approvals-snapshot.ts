import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ExecApprovalsNodeSetParams } from "../../packages/gateway-protocol/src/schema/exec-approvals.js";
import type { ExecApprovalsDefaults } from "../infra/exec-approvals.js";
import { loadSnapshotLocal } from "./exec-approvals-local.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { resolveCliNodeId } from "./nodes-cli/rpc.js";
import type { NodesRpcOpts } from "./nodes-cli/types.js";

export type FileExecApprovalsSnapshot = Awaited<ReturnType<typeof loadSnapshotLocal>> & {
  resolvedDefaults?: Required<ExecApprovalsDefaults>;
};

export type NativeExecApprovalPolicy = NonNullable<ExecApprovalsNodeSetParams["native"]>;
export type NativeExecApprovalRule = NativeExecApprovalPolicy["rules"][number];
export type NativeExecApprovalAction = NativeExecApprovalRule["action"];
export type NativeExecApprovalsSnapshot =
  | {
      enabled: true;
      hash: string;
      baseHash?: string;
      defaultAction: NativeExecApprovalAction;
      rules: NativeExecApprovalRule[];
      constraints?: Record<string, boolean>;
    }
  | { enabled: false; message?: string };
export type ExecApprovalsSnapshot = FileExecApprovalsSnapshot | NativeExecApprovalsSnapshot;

export type ApprovalsTargetSource = "gateway" | "node" | "local";

export type ExecApprovalsCliOpts = NodesRpcOpts & {
  node?: string;
  gateway?: boolean;
  file?: string;
  stdin?: boolean;
  agent?: string;
  reason?: string;
  expiresInDays?: string;
};

async function resolveTargetNodeId(opts: ExecApprovalsCliOpts): Promise<string | null> {
  const nodeTarget = normalizeOptionalString(opts.node) ?? "";
  if (opts.gateway && nodeTarget) {
    // Reject the ambiguous pair so a targeted --node write cannot silently
    // fall back to the gateway approvals policy.
    throw new Error("Pass only one of --gateway or --node.");
  }
  if (opts.gateway) {
    return null;
  }
  if (!nodeTarget) {
    return null;
  }
  return await resolveCliNodeId(opts, nodeTarget);
}

export async function loadSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
  signal?: AbortSignal,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.get" : "exec.approvals.get";
  const params = nodeId ? { nodeId } : {};
  // SAFETY: the Gateway method returns the exec approvals snapshot JSON stored by its owner.
  return (await callGatewayFromCli(method, opts, params, { signal })) as ExecApprovalsSnapshot;
}

export function isFileApprovalsSnapshot(
  snapshot: ExecApprovalsSnapshot,
): snapshot is FileExecApprovalsSnapshot {
  return "file" in snapshot;
}

export function isNativeApprovalsSnapshot(
  snapshot: ExecApprovalsSnapshot,
): snapshot is NativeExecApprovalsSnapshot {
  return "enabled" in snapshot;
}

export async function loadSnapshotTarget(
  opts: ExecApprovalsCliOpts,
  signal?: AbortSignal,
): Promise<{
  snapshot: ExecApprovalsSnapshot;
  nodeId: string | null;
  source: ApprovalsTargetSource;
}> {
  if (!opts.gateway && !opts.node) {
    return { snapshot: await loadSnapshotLocal(), nodeId: null, source: "local" };
  }
  const nodeId = await resolveTargetNodeId(opts);
  const snapshot = await loadSnapshot(opts, nodeId, signal);
  return { snapshot, nodeId, source: nodeId ? "node" : "gateway" };
}

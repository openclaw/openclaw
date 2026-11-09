import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveCliNodeId } from "./nodes-cli/rpc.js";
import type { NodesRpcOpts } from "./nodes-cli/types.js";

export async function resolveTargetNodeId(
  opts: NodesRpcOpts & { gateway?: boolean },
): Promise<string | null> {
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

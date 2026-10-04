import { ok } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { invalidSessionRequest } from "../session-request-error.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../session-utils.js";
import type { MutationTarget } from "./sessions-patch-types.js";

/** Resolve each patch target once and reject aliases targeting the same logical session. */
export function discoverSessionPatchTargets(
  cfg: OpenClawConfig,
  targets: readonly MutationTarget[],
) {
  const targetDiscoveryCache = new Map();
  const prepared = targets.map((input) => {
    const key = input.key.trim();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, input.agentId);
    return {
      input,
      key,
      requestedAgent,
      resolved: requestedAgent.ok
        ? resolveGatewaySessionStoreTargetWithStore({
            cfg,
            key,
            agentId: requestedAgent.agentId,
            exactRead: true,
            targetDiscoveryCache,
          })
        : undefined,
    };
  });
  const logicalTargets = new Set<string>();
  for (const { key, resolved } of prepared) {
    if (!resolved) {
      continue;
    }
    const logicalId = `${resolved.storePath}\0${resolved.canonicalKey ?? key}`;
    if (logicalTargets.has(logicalId)) {
      return invalidSessionRequest("Duplicate target.");
    }
    logicalTargets.add(logicalId);
  }
  return ok<typeof prepared, never>(prepared);
}

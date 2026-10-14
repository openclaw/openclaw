import { ok } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { invalidSessionRequest } from "../session-request-error.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import type { MutationTarget } from "./sessions-patch-types.js";

/** Resolve each patch target once and reject aliases targeting the same logical session. */
export async function discoverSessionPatchTargets(
  cfg: OpenClawConfig,
  targets: readonly MutationTarget[],
) {
  const prepared = await Promise.all(
    targets.map(async (input) => {
      const key = input.key.trim();
      const requestedAgent = resolveRequestedSessionAgentId(cfg, key, input.agentId);
      return {
        input,
        key,
        requestedAgent,
        resolved: requestedAgent.ok
          ? await resolveGatewaySessionStoreTargetInWorker({
              cfg,
              key,
              agentId: requestedAgent.agentId,
            })
          : undefined,
      };
    }),
  );
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

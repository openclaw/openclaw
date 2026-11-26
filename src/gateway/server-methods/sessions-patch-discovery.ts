import { ok } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { invalidSessionRequest } from "../session-request-error.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import type { ExecuteSessionPatchMutationsParams } from "./sessions-patch-types.js";

/** Resolve each patch target once and reject aliases targeting the same logical session. */
export async function discoverSessionPatchTargets(
  cfg: OpenClawConfig,
  {
    targets,
    deferredSelfSnooze,
  }: Pick<ExecuteSessionPatchMutationsParams, "targets" | "deferredSelfSnooze">,
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
    // A deferred snooze follows its chat across transcript rotation, but not to
    // a different physical store. Lifecycle admission still requires a live row.
    if (
      deferredSelfSnooze &&
      (deferredSelfSnooze.agentId !== resolved.agentId ||
        deferredSelfSnooze.sessionKey !== resolved.canonicalKey ||
        deferredSelfSnooze.storePath !== resolved.readSource?.path)
    ) {
      return invalidSessionRequest("The chat selected for self-snooze is unavailable.");
    }
    const logicalId = `${resolved.storePath}\0${resolved.canonicalKey ?? key}`;
    if (logicalTargets.has(logicalId)) {
      return invalidSessionRequest("Duplicate target.");
    }
    logicalTargets.add(logicalId);
  }
  return ok<typeof prepared, never>(prepared);
}

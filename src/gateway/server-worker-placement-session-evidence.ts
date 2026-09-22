import { getRuntimeConfig } from "../config/config.js";
import { readPlacementSessionIdentityEvidence } from "../config/sessions/session-placement-evidence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import type {
  PlacementSessionEvidence,
  PlacementSessionEvidenceResolver,
} from "./worker-environments/placement-session-retirement.js";

const log = createSubsystemLogger("gateway/placement-session-evidence");

type PlacementSessionIdentity = {
  placement: WorkerSessionPlacementRecord;
  agentId: string;
  sessionKey: string;
};

function resolvePlacementSessionIdentities(
  cfg: OpenClawConfig,
  placement: WorkerSessionPlacementRecord,
): PlacementSessionIdentity[] {
  const requestedAgentId = normalizeAgentId(placement.agentId);
  const parsedKey = parseAgentSessionKey(placement.sessionKey);
  const canonicalKey = resolveSessionStoreKey({
    cfg,
    sessionKey: placement.sessionKey,
    storeAgentId: requestedAgentId,
  });
  const canonicalAgentId =
    canonicalKey === "global" || canonicalKey === "unknown" || !parsedKey
      ? requestedAgentId
      : resolveSessionStoreAgentId(cfg, canonicalKey);
  const canonical = { placement, agentId: canonicalAgentId, sessionKey: canonicalKey };
  if (!parsedKey) {
    return [canonical];
  }
  const persistedAgentId = normalizeAgentId(parsedKey.agentId);
  if (persistedAgentId === canonicalAgentId) {
    return [canonical];
  }
  // A deleted legacy owner can still hold the exact persisted placement row.
  // Probe it alongside the canonical owner and preserve current > unknown > absent.
  return [canonical, { placement, agentId: persistedAgentId, sessionKey: placement.sessionKey }];
}

export async function createWorkerPlacementSessionEvidenceResolver(
  placements: readonly WorkerSessionPlacementRecord[],
): Promise<PlacementSessionEvidenceResolver> {
  try {
    const cfg = getRuntimeConfig();
    const identities = placements.flatMap((placement) =>
      resolvePlacementSessionIdentities(cfg, placement),
    );
    const subjects = new Map(
      placements.map((placement) => [
        placement,
        {
          agentId: placement.agentId,
          sessionId: placement.sessionId,
          sessionKey: placement.sessionKey,
        },
      ]),
    );
    const evidence = await readPlacementSessionIdentityEvidence(
      cfg,
      identities.map((identity) => ({
        agentId: identity.agentId,
        sessionId: identity.placement.sessionId,
        sessionKey: identity.sessionKey,
      })),
    );
    const evidenceByPlacement = new Map<WorkerSessionPlacementRecord, PlacementSessionEvidence>(
      placements.map((placement) => [placement, "absent"]),
    );
    for (const [index, result] of evidence.entries()) {
      const placement = identities[index]?.placement;
      if (!placement) {
        continue;
      }
      const current = evidenceByPlacement.get(placement) ?? "unknown";
      if (current !== "current" && result.status !== "absent") {
        evidenceByPlacement.set(placement, result.status);
      }
    }
    return async (placement) => {
      const subject = subjects.get(placement);
      if (
        !subject ||
        subject.agentId !== placement.agentId ||
        subject.sessionId !== placement.sessionId ||
        subject.sessionKey !== placement.sessionKey
      ) {
        return "unknown";
      }
      return evidenceByPlacement.get(placement) ?? "unknown";
    };
  } catch (error) {
    // "unknown" keeps retirement fail-open, but a silent catch would hide a broken
    // evidence pipeline (bad config, store corruption) behind indefinite retention.
    log.warn("worker placement session evidence resolution failed; treating all as unknown", {
      error,
    });
    return async () => "unknown";
  }
}

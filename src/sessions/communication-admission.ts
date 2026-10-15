import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionCommunicationPolicy } from "./communication-policy.js";

export type CommunicationEndpoint = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry | undefined;
};

export type CommunicationApproval = {
  direction: "send" | "receive";
  endpoint: CommunicationEndpoint;
};

/** Policies constrain peers, not completion already owned by a host task lifecycle. */
export function planSessionCommunication(params: {
  config: OpenClawConfig;
  source: readonly CommunicationEndpoint[];
  target: readonly CommunicationEndpoint[];
  ownedTask: boolean;
}): { allowed: true; approvals: CommunicationApproval[] } | { allowed: false; error: string } {
  const source = params.source[0];
  const target = params.target[0];
  const sameSession = Boolean(
    source?.entry?.sessionId &&
    target?.entry?.sessionId &&
    source.agentId === target.agentId &&
    source.sessionKey === target.sessionKey &&
    source.storePath === target.storePath &&
    source.entry.sessionId === target.entry.sessionId,
  );
  if (params.ownedTask || sameSession) {
    return { allowed: true, approvals: [] };
  }
  const approvals: CommunicationApproval[] = [];
  for (const [direction, endpoints] of [
    ["send", params.source],
    ["receive", params.target],
  ] as const) {
    for (const endpoint of endpoints) {
      const mode = resolveSessionCommunicationPolicy({
        config: params.config,
        entry: endpoint.entry,
      })[direction];
      if (mode === "never") {
        return {
          allowed: false,
          error:
            "Session communication " + direction + " is disabled for " + endpoint.sessionKey + ".",
        };
      }
      if (mode === "ask") {
        approvals.push({ direction, endpoint });
      }
    }
  }
  return { allowed: true, approvals };
}

/** Only communication-relevant facts bind an approval, not token/preview updates. */
export function communicationEndpointBinding(endpoint: CommunicationEndpoint): string {
  return JSON.stringify([
    endpoint.agentId,
    endpoint.sessionKey,
    endpoint.storePath,
    communicationEntryBinding(endpoint.entry),
  ]);
}

/** Stored-policy projection carried by the existing committed row publication owner. */
export function communicationEntryBinding(entry: SessionEntry | undefined): string {
  return JSON.stringify([
    entry?.sessionId,
    entry?.lifecycleRevision,
    entry?.archivedAt,
    entry?.communication,
    entry?.sandbox,
    entry?.sandboxMode,
    entry?.visibility,
    entry?.parentSessionKey,
    entry?.parentSessionId,
    entry?.spawnedBy,
    entry?.owner,
    entry?.createdActor,
  ]);
}

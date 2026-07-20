import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export function resolveAgentDedupeOwnerIdentity(
  client: GatewayClient | null | undefined,
): string | undefined {
  const authenticatedUserId = normalizeOptionalString(client?.authenticatedUserId);
  if (authenticatedUserId) {
    return JSON.stringify(["user", authenticatedUserId]);
  }
  const pairedClientId = normalizeOptionalString(client?.pairedClientId);
  if (pairedClientId) {
    return JSON.stringify(["paired-client", pairedClientId]);
  }
  const deviceId = normalizeOptionalString(client?.connect?.device?.id);
  if (deviceId) {
    return JSON.stringify(["device", deviceId]);
  }
  const runtimeIdentity = client?.internal?.agentRuntimeIdentity;
  if (runtimeIdentity) {
    return JSON.stringify(["agent-runtime", runtimeIdentity.agentId, runtimeIdentity.sessionKey]);
  }
  const pluginRuntimeOwnerId = normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId);
  if (pluginRuntimeOwnerId) {
    return JSON.stringify(["plugin-runtime", pluginRuntimeOwnerId]);
  }
  const connId = normalizeOptionalString(client?.connId);
  return connId ? JSON.stringify(["connection", connId]) : undefined;
}

export function canClientReadAgentDedupeEntry(params: {
  client: GatewayClient | null | undefined;
  entry: ReturnType<typeof readGatewayDedupeEntry>;
}): boolean {
  const scopes = Array.isArray(params.client?.connect?.scopes) ? params.client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  const requesterIdentity = resolveAgentDedupeOwnerIdentity(params.client);
  return Boolean(requesterIdentity && requesterIdentity === params.entry?.agentDedupeOwnerIdentity);
}

export function resolveAgentDedupeKeys(params: {
  idempotencyKey: string;
  execApprovalFollowupApprovalId?: string;
}): string[] {
  const keys = [`agent:${params.idempotencyKey}`];
  const approvalId = params.execApprovalFollowupApprovalId?.trim();
  if (approvalId) {
    keys.push(`agent:exec-approval-followup:${approvalId}`);
  }
  return uniqueStrings(keys);
}

export function readGatewayDedupeEntry(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
}) {
  for (const key of params.keys) {
    const entry = params.dedupe.get(key);
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

export function isAcceptedAgentDedupePayload(payload: unknown): payload is {
  acceptedAt?: unknown;
  agentId?: unknown;
  dedupeKeys?: unknown;
  expiresAtMs?: unknown;
  ownerConnId?: unknown;
  ownerDeviceId?: unknown;
  reservationId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  status: "accepted";
} {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { status?: unknown }).status === "accepted"
  );
}

function isPreRegistrationAbortedAgentDedupePayload(payload: unknown): payload is {
  agentId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  status: "timeout";
  stopReason?: unknown;
} {
  const stopReason = (payload as { stopReason?: unknown } | null)?.stopReason;
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { status?: unknown }).status === "timeout" &&
    (stopReason === "rpc" || stopReason === "stop")
  );
}

export function isPreRegistrationAbortedAgentDedupeEntryForSession(params: {
  entry: ReturnType<typeof readGatewayDedupeEntry> | undefined;
  runId: string;
  sessionKey?: string;
  alternateSessionKeys?: Array<string | undefined>;
}): boolean {
  if (!params.entry?.ok || !isPreRegistrationAbortedAgentDedupePayload(params.entry.payload)) {
    return false;
  }
  const payload = params.entry.payload;
  const payloadRunId = typeof payload.runId === "string" ? payload.runId.trim() : "";
  if (payloadRunId && payloadRunId !== params.runId) {
    return false;
  }
  const payloadSessionKey =
    typeof payload.sessionKey === "string" && payload.sessionKey.trim()
      ? payload.sessionKey.trim()
      : undefined;
  const expectedSessionKeys = new Set(
    [params.sessionKey, ...(params.alternateSessionKeys ?? [])].filter((value): value is string =>
      Boolean(value?.trim()),
    ),
  );
  return (
    !payloadSessionKey ||
    expectedSessionKeys.size === 0 ||
    expectedSessionKeys.has(payloadSessionKey)
  );
}

export function setGatewayDedupeEntries(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
  entry: Parameters<typeof setGatewayDedupeEntry>[0]["entry"];
}): void {
  for (const key of params.keys) {
    const existingOwnerIdentity = params.dedupe.get(key)?.agentDedupeOwnerIdentity;
    // Terminal writes replace accepted payloads; retain the caller binding so a later
    // idempotent replay cannot expose the result to another authenticated client.
    setGatewayDedupeEntry({
      dedupe: params.dedupe,
      key,
      entry:
        params.entry.agentDedupeOwnerIdentity || !existingOwnerIdentity
          ? params.entry
          : { ...params.entry, agentDedupeOwnerIdentity: existingOwnerIdentity },
    });
  }
}

export function setAbortedAgentDedupeEntries(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
  agentId?: string;
  sessionKey?: string;
  runId: string;
  stopReason: string;
}): void {
  setGatewayDedupeEntries({
    dedupe: params.dedupe,
    keys: params.keys,
    entry: {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: params.runId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        status: "timeout" as const,
        summary: "aborted",
        stopReason: params.stopReason,
        timeoutPhase: "queue",
        providerStarted: false,
      },
    },
  });
}

import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { readOfflineStorageScope, type OfflineStorageClient } from "../../app/boot-record.ts";
import {
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";

type ChatSnapshotKeyHost = Pick<
  UiSessionDefaultsHost,
  "assistantAgentId" | "agentsList" | "hello"
> & {
  settings?: { gatewayUrl?: string | null };
  client?: OfflineStorageClient | null;
  connected?: boolean;
};

type ChatSnapshotKeyTarget = {
  sessionKey: string;
  agentId?: string | null;
};

const unownedKeys = new WeakMap<object, number>();
let nextUnownedKey = 0;
function unownedKey(host: ChatSnapshotKeyHost): number {
  const source = host.client ?? host;
  let key = unownedKeys.get(source);
  if (key === undefined) {
    key = ++nextUnownedKey;
    unownedKeys.set(source, key);
  }
  return key;
}

export function resolveChatSnapshotSessionKey(
  host: ChatSnapshotKeyHost,
  target: ChatSnapshotKeyTarget,
): string {
  const parsed = parseAgentSessionKey(target.sessionKey);
  const explicitAgentId = target.agentId?.trim();
  const agentId = explicitAgentId
    ? normalizeAgentId(explicitAgentId)
    : parsed
      ? normalizeAgentId(parsed.agentId)
      : isUiGlobalSessionKey(target.sessionKey)
        ? resolveUiSelectedGlobalAgentId(host)
        : resolveUiDefaultAgentId(host);
  const normalizedSessionKey = normalizeSessionKeyForUiComparison(target.sessionKey);
  const normalized = parsed
    ? normalizedSessionKey.split(":").slice(2).join(":")
    : normalizedSessionKey;
  const configuredMainKey = resolveUiConfiguredMainKey(host);
  const sessionKey =
    isUiGlobalSessionKey(target.sessionKey) ||
    normalized === DEFAULT_MAIN_KEY ||
    normalized === configuredMainKey
      ? DEFAULT_MAIN_KEY
      : normalized;
  return `agent:${agentId}:${sessionKey}`;
}

export function resolveChatSnapshotKey(
  host: ChatSnapshotKeyHost,
  target: ChatSnapshotKeyTarget,
): string {
  const sessionKey = resolveChatSnapshotSessionKey(host, target);
  const gateway = host.settings?.gatewayUrl;
  // Transcript identity is descriptive: recovery readiness gates sends, not the
  // same account’s already-owned cursor while hello finishes local migration.
  const account = readOfflineStorageScope({ client: host.client });
  const owner =
    gateway && account
      ? JSON.stringify([gatewayCredentialScope(gateway), account])
      : `unowned:${unownedKey(host)}`;
  return `scope:${owner}\u0000${sessionKey}`;
}

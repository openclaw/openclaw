import {
  resolveSessionKey,
  type SessionCapability,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";

type ChatPickerPatchHost = SessionScopeHost & { sessions: SessionCapability };
type PendingPatchStore = WeakMap<SessionCapability, Map<string, Promise<boolean>>>;

const pendingChatPickerPatches: PendingPatchStore = new WeakMap();
const pendingChatModelSwitches: PendingPatchStore = new WeakMap();

function resolveChatPickerPatchKey(
  host: ChatPickerPatchHost,
  sessionKey: string,
  agentId?: string,
): string {
  const normalizedKey = normalizeSessionKeyForUiComparison(sessionKey);
  const match = /^agent:([^:]+):(.*)$/u.exec(normalizedKey);
  const body = match?.[2] ?? normalizedKey;
  const isGlobal = isUiGlobalSessionKey(sessionKey);
  const isMainAlias = [DEFAULT_MAIN_KEY, resolveUiConfiguredMainKey(host)].includes(
    body.toLowerCase(),
  );
  const defaultAgentId = resolveUiDefaultAgentId(host);
  const parsedAgentId = match?.[1];
  // Match the Gateway's legacy default-main remap only when the live agent
  // catalog proves that "main" is not a real agent.
  const isLegacyDefaultMainAlias =
    isMainAlias &&
    normalizeAgentId(parsedAgentId ?? "") === DEFAULT_AGENT_ID &&
    defaultAgentId !== DEFAULT_AGENT_ID &&
    host.agentsList?.agents != null &&
    !host.agentsList.agents.some(
      (candidate) => normalizeAgentId(candidate.id) === DEFAULT_AGENT_ID,
    );
  // Main aliases share the literal global store only in global session scope.
  const isGlobalMain = host.agentsList?.scope
    ? host.agentsList.scope === "global"
    : isUiGlobalSessionKey(resolveSessionKey(DEFAULT_MAIN_KEY, host.hello));
  const resolvedAgentId =
    (isLegacyDefaultMainAlias ? defaultAgentId : agentId?.trim() || parsedAgentId) ||
    (isGlobal ? resolveUiSelectedGlobalAgentId(host) : defaultAgentId);
  const settingsKey =
    isGlobal || (isMainAlias && isGlobalMain) ? "global" : isMainAlias ? DEFAULT_MAIN_KEY : body;
  return `agent:${normalizeAgentId(resolvedAgentId)}:${settingsKey}`;
}

function getPendingPatch(
  store: PendingPatchStore,
  host: ChatPickerPatchHost,
  sessionKey: string,
  agentId?: string,
): Promise<boolean> | undefined {
  const patchKey = resolveChatPickerPatchKey(host, sessionKey, agentId);
  return store.get(host.sessions)?.get(patchKey);
}

function trackLatestPatch(
  store: PendingPatchStore,
  host: ChatPickerPatchHost,
  sessionKey: string,
  patchPromise: Promise<boolean>,
): void {
  const pendingBySession = store.get(host.sessions) ?? new Map<string, Promise<boolean>>();
  store.set(host.sessions, pendingBySession);
  const patchKey = resolveChatPickerPatchKey(host, sessionKey);
  pendingBySession.set(patchKey, patchPromise);
  void patchPromise.finally(() => {
    if (pendingBySession.get(patchKey) === patchPromise) {
      pendingBySession.delete(patchKey);
    }
  });
}

export function getPendingChatPickerPatch(
  host: ChatPickerPatchHost,
  sessionKey: string,
  agentId?: string,
): Promise<boolean> | undefined {
  return getPendingPatch(pendingChatPickerPatches, host, sessionKey, agentId);
}

export function trackPendingChatPickerPatch(
  host: ChatPickerPatchHost,
  sessionKey: string,
  patchPromise: Promise<boolean>,
): void {
  const previous = getPendingChatPickerPatch(host, sessionKey);
  // Aggregate every picker patch across the shared capability; overlapping
  // Gateway handlers can overtake pane-local or latest-only tracking.
  const pending = Promise.all([previous ?? true, patchPromise]).then(
    ([previousReady, patchReady]) => previousReady && patchReady,
  );
  trackLatestPatch(pendingChatPickerPatches, host, sessionKey, pending);
}

export function getPendingChatModelSwitch(
  host: ChatPickerPatchHost,
  sessionKey: string,
): Promise<boolean> | undefined {
  return getPendingPatch(pendingChatModelSwitches, host, sessionKey);
}

export function trackPendingChatModelSwitch(
  host: ChatPickerPatchHost,
  sessionKey: string,
  switchPromise: Promise<boolean>,
): void {
  trackLatestPatch(pendingChatModelSwitches, host, sessionKey, switchPromise);
}

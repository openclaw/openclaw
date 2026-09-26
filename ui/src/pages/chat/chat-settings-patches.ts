import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveSessionKey,
  type SessionCapability,
  type SessionPatch,
  type SessionPatchResult,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";

type ChatPickerPatchHost = SessionScopeHost & { sessions: SessionCapability };
type ChatCommandSettingsContext = {
  sessions: SessionCapability;
  defaultAgentId?: string;
  agentId?: string;
};
type PendingChatPickerPatch = {
  ready: Promise<boolean>;
  receipt: ReturnType<typeof createChatPickerPatchReceipt>;
};
const pendingChatPickerPatches = new WeakMap<
  SessionCapability,
  Map<string, PendingChatPickerPatch>
>();

function createChatPickerPatchReceipt(sessions: SessionCapability) {
  const scope = sessions.captureConnectionScope();
  const isCurrent = () => Boolean(scope && sessions.isConnectionScopeCurrent(scope));
  let confirmed: SessionPatchResult | null = null;
  const listeners = new Set<() => void>();
  return {
    isCurrent,
    read: () => (isCurrent() ? confirmed : null),
    subscribe(onConfirmed: () => void) {
      listeners.add(onConfirmed);
      return () => {
        listeners.delete(onConfirmed);
      };
    },
    confirm: (receipt: SessionPatchResult) => {
      if (!isCurrent()) {
        return;
      }
      confirmed = receipt;
      // Decoration can change subscriptions while this receipt is being published.
      const currentListeners = [...listeners];
      for (const listener of currentListeners) {
        listener();
      }
    },
  };
}

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

export function getPendingChatPickerPatch(
  host: ChatPickerPatchHost,
  sessionKey: string,
  agentId?: string,
): Promise<boolean> | undefined {
  const patchKey = resolveChatPickerPatchKey(host, sessionKey, agentId);
  return pendingChatPickerPatches.get(host.sessions)?.get(patchKey)?.ready;
}

export function patchChatSessionSettings(
  host: ChatPickerPatchHost,
  sessionKey: string,
  patch: SessionPatch,
  options: {
    agentId?: string;
    expectedSessionId?: string;
    ownsModelOverride?: () => boolean;
    canDispatch?: (receipt: SessionPatchResult | null) => boolean;
    onRejected?: (error: unknown, receipt: SessionPatchResult | null) => void;
    reconcile?: (result: SessionPatchResult) => Promise<void> | void;
  } = {},
): Promise<SessionPatchResult | null> {
  const sessions = host.sessions;
  const patchKey = resolveChatPickerPatchKey(host, sessionKey, options.agentId);
  const pendingBySession =
    pendingChatPickerPatches.get(sessions) ?? new Map<string, PendingChatPickerPatch>();
  pendingChatPickerPatches.set(sessions, pendingBySession);
  const previous = pendingBySession.get(patchKey);
  const waitFor = previous?.ready;
  // One flat receipt source survives failed intermediate writes without retaining
  // settled predecessors. Each pending capability claim owns its subscription.
  const receipt = previous?.receipt.isCurrent()
    ? previous.receipt
    : createChatPickerPatchReceipt(sessions);
  const canDispatch = options.canDispatch;
  const operation: Promise<SessionPatchResult | null> = (async () => {
    // Run-affecting settings and sends share this canonical per-session tail.
    // The capability captures this route before waiting, so a reconnect cannot
    // redirect queued intent to a replacement Gateway.
    const result = await sessions.patch(sessionKey, patch, {
      agentId: options.agentId,
      expectedSessionId: options.expectedSessionId,
      ownsModelOverride: options.ownsModelOverride,
      canDispatch: canDispatch ? () => canDispatch(receipt.read()) : undefined,
      onConfirmed: receipt.confirm,
      onRejected: (error) => options.onRejected?.(error, receipt.read()),
      waitFor,
      ...(waitFor ? { predecessorReceipt: receipt } : {}),
    });
    if (result) {
      await options.reconcile?.(result);
    }
    return result;
  })();
  const pending: PendingChatPickerPatch = {
    ready: operation.then(
      (result) => result !== null,
      () => false,
    ),
    receipt,
  };
  pendingBySession.set(patchKey, pending);
  void pending.ready.finally(() => {
    if (pendingBySession.get(patchKey) === pending) {
      pendingBySession.delete(patchKey);
    }
  });
  return operation;
}

export function selectedGlobalScope(
  sessionKey: string,
  context: Pick<ChatCommandSettingsContext, "agentId">,
): { agentId?: string } {
  const normalizedSessionKey = normalizeOptionalLowercaseString(sessionKey);
  const parsed = parseAgentSessionKey(normalizedSessionKey ?? "");
  const aliasAgentId =
    parsed &&
    parsed.agentId !== DEFAULT_AGENT_ID &&
    (parsed.rest === DEFAULT_MAIN_KEY || parsed.rest === "global")
      ? parsed.agentId
      : undefined;
  const agentId = aliasAgentId ?? normalizeOptionalLowercaseString(context.agentId);
  return (normalizedSessionKey === "global" || aliasAgentId) && agentId ? { agentId } : {};
}

export async function patchChatCommandSessionSettings(
  context: ChatCommandSettingsContext,
  sessionKey: string,
  patch: SessionPatch,
  options: {
    ownsModelOverride?: () => boolean;
    reconcile?: (result: SessionPatchResult) => Promise<void> | void;
  } = {},
): Promise<NonNullable<Awaited<ReturnType<SessionCapability["patch"]>>>> {
  const result = await patchChatSessionSettings(
    {
      sessions: context.sessions,
      assistantAgentId: context.agentId,
      agentsList: context.defaultAgentId ? { defaultId: context.defaultAgentId } : null,
      hello: null,
    },
    sessionKey,
    patch,
    { ...selectedGlobalScope(sessionKey, context), ...options },
  );
  if (!result) {
    throw new Error("Session capability is unavailable");
  }
  return result;
}

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  readAgentRuntimeRestrictionErrorDetails,
  type AgentRuntimeRestrictionErrorDetails,
} from "../../../../packages/gateway-protocol/src/index.js";
import { normalizeThinkLevel } from "../../../../src/auto-reply/thinking.shared.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { FastMode, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { resolvePreferredServerChatModelValue } from "../../lib/chat/model-ref.ts";
import { resolveChatModelOverrideValue } from "../../lib/chat/model-select-state.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isSessionRuntimePinned } from "../../lib/model-runtime-choice.ts";
import {
  DEFAULT_SESSION_LIST_QUERY,
  scopedAgentParamsForSession,
  scopedAgentListParamsForRefreshTarget,
  scopedAgentListParamsForSession,
  type SessionCapability,
  type SessionArchivedFilter,
  type SessionListOptions,
  type SessionRefreshTarget,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { getPendingChatPickerPatch, patchChatSessionSettings } from "./chat-settings-patches.ts";
export { getPendingChatPickerPatch };

registerModelControlsEnglish();

type ChatSessionListHost = {
  sessionsArchivedFilter?: SessionArchivedFilter;
};

type ChatSessionRefreshHost = ChatSessionListHost &
  SessionScopeHost & {
    sessionKey: string;
    sessions: Pick<SessionCapability, "refresh">;
  };

type ChatModelSettingsHost = ChatSessionRefreshHost & {
  client: unknown;
  connected: boolean;
  connectionEpoch?: number;
  lastError?: string | null;
  chatError?: string | null;
  chatModelCatalog: Parameters<typeof resolveChatModelOverrideValue>[0]["chatModelCatalog"];
  chatModelSwitchPromises?: Record<string, Promise<boolean>>;
  chatThinkingLevel: string | null;
  sessions: SessionCapability;
  sessionsResult?: SessionsListResult | null;
  requestUpdate?: () => void;
};

const modelSelectionOwners = new WeakMap<object, AbortController>();

export function cancelChatModelRecovery(host: object): void {
  modelSelectionOwners.get(host)?.abort();
  modelSelectionOwners.delete(host);
}

export function retireChatModelSelectionOwnership(
  host: Pick<
    ChatModelSettingsHost,
    "agentsList" | "chatModelSwitchPromises" | "hello" | "requestUpdate" | "sessionKey" | "sessions"
  >,
): void {
  cancelChatModelRecovery(host);
  const pendingKeys = Object.keys(host.chatModelSwitchPromises ?? {});
  const ownedKeys = new Set([host.sessionKey, ...pendingKeys]);
  if (isUiSelectedGlobalSessionKey(host, host.sessionKey)) {
    ownedKeys.add("global");
  }
  const hasPendingSwitch = pendingKeys.length > 0;
  const modelOverrides = host.sessions.state?.modelOverrides ?? {};
  const hasModelOverride = [...ownedKeys].some((key) => Object.hasOwn(modelOverrides, key));
  if (!hasPendingSwitch && !hasModelOverride) {
    return;
  }
  host.chatModelSwitchPromises = {};
  for (const key of ownedKeys) {
    host.sessions.retireModelOverride(key);
  }
  host.requestUpdate?.();
}

function buildChatSessionListOptions(
  state: ChatSessionListHost,
  options: { offset?: number; append?: boolean; search?: string | null } = {},
): SessionListOptions {
  const result: SessionListOptions = {
    ...DEFAULT_SESSION_LIST_QUERY,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    includeDerivedTitles: true,
    archivedFilter: state.sessionsArchivedFilter ?? "active",
  };
  const search = normalizeOptionalString(options.search ?? undefined);
  if (search) {
    result.search = search;
  }
  const offset =
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
  if (offset > 0) {
    result.offset = offset;
  }
  if (options.append === true) {
    result.append = true;
  }
  return result;
}

export function refreshCurrentChatSessionList(host: ChatSessionRefreshHost): Promise<void> {
  return host.sessions.refresh({
    ...buildChatSessionListOptions(host),
    ...scopedAgentListParamsForSession(host, host.sessionKey),
    force: true,
  });
}

export function refreshChatSessionListForTarget(
  host: ChatSessionListHost &
    SessionScopeHost & {
      sessions: Pick<SessionCapability, "refresh">;
    },
  target: SessionRefreshTarget,
): Promise<void> {
  return host.sessions.refresh({
    ...buildChatSessionListOptions(host),
    ...scopedAgentListParamsForRefreshTarget(host, target),
    force: true,
  });
}

function setChatError(host: ChatModelSettingsHost, error: string | null, requestUpdate = false) {
  const message = error === null ? null : formatUiError(error);
  host.lastError = message;
  host.chatError = message;
  if (requestUpdate) {
    host.requestUpdate?.();
  }
}

// Immediate-apply pickers can overlap patches for the same session. Mirror the
// pendingModelPatches token guard in sessions/index.ts: only the latest patch
// may re-assert or roll back the optimistic row, so a slow earlier request
// cannot clobber a newer selection.
const chatFastModePatchTokens = new WeakMap<object, Map<string, symbol>>();
const chatThinkingPatchTokens = new WeakMap<object, Map<string, symbol>>();
const chatContextWindowPatchTokens = new WeakMap<object, Map<string, symbol>>();

function claimChatSettingsPatch(
  store: WeakMap<object, Map<string, symbol>>,
  host: object,
  sessionKey: string,
): symbol {
  let tokens = store.get(host);
  if (!tokens) {
    tokens = new Map();
    store.set(host, tokens);
  }
  const token = Symbol(sessionKey);
  tokens.set(sessionKey, token);
  return token;
}

function isCurrentChatSettingsPatch(
  store: WeakMap<object, Map<string, symbol>>,
  host: object,
  sessionKey: string,
  token: symbol,
): boolean {
  return store.get(host)?.get(sessionKey) === token;
}

function patchSessionRow(
  host: ChatModelSettingsHost,
  sessionKey: string,
  patch: Partial<SessionsListResult["sessions"][number]>,
) {
  // Mirror into the capability snapshot first: publishes replace the host copy
  // wholesale, so without the mirror any mid-flight publish reverts this patch
  // until the post-patch list refresh lands (visible slider snap-back that can
  // swallow the next keyboard commit). The host copy still updates directly so
  // hosts without a live capability subscription stay coherent.
  host.sessions.patchRowLocal(sessionKey, patch);
  const current = host.sessionsResult;
  if (!current) {
    return;
  }
  host.sessionsResult = {
    ...current,
    sessions: current.sessions.map((row) =>
      areUiSessionKeysEquivalent(row.key, sessionKey) ? Object.assign({}, row, patch) : row,
    ),
  };
}

export function switchChatFastMode(
  host: ChatModelSettingsHost,
  nextFastMode: "" | "on" | "off" | "auto",
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const activeRow = host.sessionsResult?.sessions?.find((row) =>
    areUiSessionKeysEquivalent(row.key, targetSessionKey),
  );
  const previousFastMode = activeRow?.fastMode;
  const previousEffectiveFastMode = activeRow?.effectiveFastMode;
  const next: FastMode | undefined =
    nextFastMode === "" ? undefined : nextFastMode === "auto" ? "auto" : nextFastMode === "on";
  if (previousFastMode === next) {
    return Promise.resolve(true);
  }
  const token = claimChatSettingsPatch(chatFastModePatchTokens, host, targetSessionKey);
  setChatError(host, null, true);
  // Patch effectiveFastMode too: the toggle displays the effective value, and
  // the server-resolved one stays stale until the session list refreshes.
  patchSessionRow(host, targetSessionKey, { fastMode: next, effectiveFastMode: next });
  const rollback = () => {
    if (isCurrentChatSettingsPatch(chatFastModePatchTokens, host, targetSessionKey, token)) {
      patchSessionRow(host, targetSessionKey, {
        fastMode: previousFastMode,
        effectiveFastMode: previousEffectiveFastMode,
      });
    }
  };
  const patchPromise = (async () => {
    try {
      const patched = await patchChatSessionSettings(
        host,
        targetSessionKey,
        {
          fastMode: next ?? null,
        },
        {
          ...scopedAgentParamsForSession(host, targetSessionKey),
          reconcile: async () => refreshCurrentChatSessionList(host),
        },
      );
      if (!patched) {
        rollback();
        return false;
      }
      if (isCurrentChatSettingsPatch(chatFastModePatchTokens, host, targetSessionKey, token)) {
        patchSessionRow(host, targetSessionKey, { fastMode: next });
      }
      return true;
    } catch (err) {
      rollback();
      setChatError(host, `Failed to set speed: ${formatUiError(err)}`, true);
      return false;
    }
  })();
  return patchPromise;
}

type ChatModelSelection = {
  owner: AbortController;
  ownsSelection: (sessionId?: string) => boolean;
  agentScope: { agentId?: string };
  expectedSessionId?: string;
  activeRow?: GatewaySessionRow;
  adoptCreatedSession: (sessionId: string) => boolean;
};

function claimChatModelSelection(host: ChatModelSettingsHost, targetSessionKey: string) {
  modelSelectionOwners.get(host)?.abort();
  const owner = new AbortController();
  modelSelectionOwners.set(host, owner);
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  const sessions = host.sessions;
  const selectedSessionKey = host.sessionKey;
  const agentScope = scopedAgentParamsForSession(host, targetSessionKey);
  const activeRow = host.sessionsResult?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, targetSessionKey),
  );
  let expectedSessionId = activeRow?.sessionId;
  const ownsSelection = (sessionId = expectedSessionId) =>
    !owner.signal.aborted &&
    modelSelectionOwners.get(host) === owner &&
    host.connected &&
    host.client === client &&
    host.connectionEpoch === connectionEpoch &&
    host.sessions === sessions &&
    host.sessionKey === selectedSessionKey &&
    scopedAgentParamsForSession(host, targetSessionKey).agentId === agentScope.agentId &&
    host.sessionsResult?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, targetSessionKey),
    )?.sessionId === sessionId;
  return {
    owner,
    ownsSelection,
    agentScope,
    get expectedSessionId() {
      return expectedSessionId;
    },
    activeRow,
    adoptCreatedSession(sessionId: string) {
      if (expectedSessionId !== undefined || !ownsSelection(sessionId)) {
        return false;
      }
      expectedSessionId = sessionId;
      return true;
    },
  };
}

async function confirmChatNativeRuntimeRecovery(
  host: ChatModelSettingsHost,
  restriction: AgentRuntimeRestrictionErrorDetails,
  targetSessionKey: string,
  model: string | undefined,
  selection: ChatModelSelection,
  selectionUnchanged: () => boolean = () => true,
  retriesMessage = false,
): Promise<boolean> {
  const { owner, ownsSelection, agentScope } = selection;
  const explanation = t(`chat.nativeRuntimeRecovery.reasons.${restriction.reason}`, {
    runtime: restriction.runtimeLabel,
  });
  const blocked = () =>
    setChatError(host, `${explanation} ${t("chat.nativeRuntimeRecovery.chooseAnother")}`, true);
  const canRecover = () => ownsSelection() && selectionUnchanged();
  try {
    const materializedSessionId = restriction.recovery?.sessionId;
    if (selection.expectedSessionId === undefined && materializedSessionId) {
      if (!ownsSelection() && !ownsSelection(materializedSessionId)) {
        return false;
      }
      await refreshChatSessionListForTarget(host, { sessionKey: targetSessionKey, ...agentScope });
      if (!selection.adoptCreatedSession(materializedSessionId)) {
        return false;
      }
    }
    if (!ownsSelection()) {
      return false;
    }
    // Consent is a refusal-only action, not part of ordinary settings or send startup.
    const { confirmNativeRuntimePermissionRecovery } =
      await import("./chat-native-runtime-recovery.ts");
    const recovered = await confirmNativeRuntimePermissionRecovery(
      host,
      targetSessionKey,
      restriction,
      {
        ...agentScope,
        ...(model !== undefined ? { model: model || null } : {}),
        expectedSessionId: selection.expectedSessionId,
        signal: owner.signal,
        retriesMessage,
        canDispatch: canRecover,
      },
    );
    if (!recovered && canRecover()) {
      blocked();
    }
    if (!ownsSelection() || !recovered) {
      return false;
    }
    setChatError(
      host,
      recovered.listRefreshError
        ? t("chat.nativeRuntimeRecovery.refreshFailed", { error: recovered.listRefreshError })
        : null,
      true,
    );
    return true;
  } catch (error) {
    if (ownsSelection()) {
      setChatError(
        host,
        t("chat.nativeRuntimeRecovery.failed", { error: formatUiError(error) }),
        true,
      );
    }
    return false;
  }
}

export function captureChatNativeRuntimeRecovery(
  host: ChatModelSettingsHost,
  targetSessionKey: string,
): (restriction: AgentRuntimeRestrictionErrorDetails) => Promise<(() => boolean) | undefined> {
  const selection = claimChatModelSelection(host, targetSessionKey);
  const unbound = selection.expectedSessionId === undefined;
  const model = selection.activeRow?.model;
  const provider = selection.activeRow?.modelProvider;
  const runtimeId = selection.activeRow?.agentRuntime?.id;
  const overrideValue = resolveChatModelOverrideValue({
    activeSession: selection.activeRow,
    chatModelCatalog: host.chatModelCatalog,
    modelOverrides: host.sessions.state.modelOverrides,
    sessionKey: targetSessionKey,
    sessionsResult: host.sessionsResult ?? null,
  });
  const modelValue =
    overrideValue ||
    resolvePreferredServerChatModelValue(
      host.sessionsResult?.defaults?.model,
      host.sessionsResult?.defaults?.modelProvider,
      host.chatModelCatalog,
    );
  return async (restriction) => {
    const recovered = await confirmChatNativeRuntimeRecovery(
      host,
      restriction,
      targetSessionKey,
      undefined,
      selection,
      () => {
        const row = host.sessionsResult?.sessions.find((candidate) =>
          areUiSessionKeysEquivalent(candidate.key, targetSessionKey),
        );
        if (unbound) {
          return Boolean(
            modelValue &&
            resolvePreferredServerChatModelValue(
              row?.model,
              row?.modelProvider,
              host.chatModelCatalog,
            ) === modelValue &&
            row?.agentRuntime?.id === restriction.runtimeId &&
            (!runtimeId || runtimeId === restriction.runtimeId),
          );
        }
        return Boolean(
          modelValue &&
          row?.model === model &&
          row?.modelProvider === provider &&
          row?.agentRuntime?.id === runtimeId &&
          runtimeId === restriction.runtimeId,
        );
      },
      true,
    );
    if (!recovered) {
      return undefined;
    }
    const readRow = () =>
      host.sessionsResult?.sessions.find((row) =>
        areUiSessionKeysEquivalent(row.key, targetSessionKey),
      );
    const confirmed = readRow();
    const confirmedModel = confirmed?.model;
    const confirmedProvider = confirmed?.modelProvider;
    const confirmedRuntime = confirmed?.agentRuntime?.id;
    return () => {
      const current = readRow();
      return (
        selection.ownsSelection() &&
        current?.model === confirmedModel &&
        current?.modelProvider === confirmedProvider &&
        current?.agentRuntime?.id === confirmedRuntime
      );
    };
  };
}

export async function switchChatModel(
  host: ChatModelSettingsHost,
  nextModel: string,
  targetSessionKey = host.sessionKey,
  agentRuntime?: string | null,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return false;
  }
  const activeRow = host.sessionsResult?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, targetSessionKey),
  );
  if (activeRow?.modelSelectionLocked === true) {
    return false;
  }
  // A newer intent retires even a confirmation for a previous selection.
  const selection = claimChatModelSelection(host, targetSessionKey);
  const { ownsSelection, agentScope } = selection;
  const currentOverride = resolveChatModelOverrideValue({
    activeSession: activeRow,
    chatModelCatalog: host.chatModelCatalog,
    modelOverrides: host.sessions.state.modelOverrides,
    sessionKey: targetSessionKey,
    sessionsResult: host.sessionsResult ?? null,
  });
  const runtimeSelection =
    activeRow?.runtimeSelectionLocked && agentRuntime === null ? undefined : agentRuntime;
  const runtimeUnchanged =
    runtimeSelection === undefined ||
    (!activeRow?.runtimeSelectionLocked &&
      (runtimeSelection === null
        ? !isSessionRuntimePinned(activeRow?.agentRuntime)
        : isSessionRuntimePinned(activeRow?.agentRuntime) &&
          activeRow?.agentRuntime?.id === runtimeSelection));
  if (currentOverride === nextModel && runtimeUnchanged) {
    return true;
  }
  const modelOwnerAgentId = scopedAgentParamsForSession(host, targetSessionKey).agentId;
  const ownsModelOverride = () =>
    !isUiSelectedGlobalSessionKey(host, targetSessionKey) ||
    resolveUiSelectedGlobalAgentId(host) === modelOwnerAgentId;
  setChatError(host, null, true);
  const switchPromiseRef: { current?: Promise<boolean> } = {};
  const clearPendingSwitch = () => {
    if (host.chatModelSwitchPromises?.[targetSessionKey] === switchPromiseRef.current) {
      const nextSwitches = { ...host.chatModelSwitchPromises };
      delete nextSwitches[targetSessionKey];
      host.chatModelSwitchPromises = nextSwitches;
    }
  };
  const switchPromise: Promise<boolean> = (async () => {
    try {
      const patched = await patchChatSessionSettings(
        host,
        targetSessionKey,
        {
          model: nextModel || null,
          ...(runtimeSelection !== undefined ? { agentRuntime: runtimeSelection } : {}),
        },
        {
          ...agentScope,
          ownsModelOverride,
          reconcile: async () => {
            await refreshCurrentChatSessionList(host);
          },
        },
      );
      if (!patched) {
        return false;
      }
      return true;
    } catch (err) {
      if (!ownsSelection()) {
        return false;
      }
      const restriction =
        err instanceof GatewayRequestError
          ? readAgentRuntimeRestrictionErrorDetails(err.details)
          : undefined;
      if (!restriction) {
        setChatError(host, `Failed to set model: ${formatUiError(err)}`, true);
        return false;
      }
      return await confirmChatNativeRuntimeRecovery(
        host,
        restriction,
        targetSessionKey,
        nextModel,
        selection,
        () => !runtimeSelection || runtimeSelection === restriction.runtimeId,
      );
    } finally {
      clearPendingSwitch();
      host.requestUpdate?.();
    }
  })();
  switchPromiseRef.current = switchPromise;
  host.chatModelSwitchPromises = {
    ...host.chatModelSwitchPromises,
    [targetSessionKey]: switchPromise,
  };
  host.requestUpdate?.();
  return switchPromise;
}

export function switchChatThinkingLevel(
  host: ChatModelSettingsHost,
  nextThinkingLevel: string,
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const activeRow = host.sessionsResult?.sessions?.find((row) =>
    areUiSessionKeysEquivalent(row.key, targetSessionKey),
  );
  const previousThinkingLevel = activeRow?.thinkingLevel;
  const normalizedNext =
    (normalizeThinkLevel(nextThinkingLevel) ?? nextThinkingLevel.trim()) || undefined;
  const normalizedPrev =
    typeof previousThinkingLevel === "string" && previousThinkingLevel.trim()
      ? (normalizeThinkLevel(previousThinkingLevel) ?? previousThinkingLevel.trim())
      : undefined;
  if ((normalizedPrev ?? "") === (normalizedNext ?? "")) {
    return Promise.resolve(true);
  }
  const token = claimChatSettingsPatch(chatThinkingPatchTokens, host, targetSessionKey);
  setChatError(host, null, true);
  patchSessionRow(host, targetSessionKey, { thinkingLevel: normalizedNext });
  if (host.sessionKey === targetSessionKey) {
    host.chatThinkingLevel = normalizedNext ?? null;
  }
  const rollback = () => {
    if (isCurrentChatSettingsPatch(chatThinkingPatchTokens, host, targetSessionKey, token)) {
      patchSessionRow(host, targetSessionKey, { thinkingLevel: previousThinkingLevel });
      if (host.sessionKey === targetSessionKey) {
        host.chatThinkingLevel = normalizedPrev ?? null;
      }
    }
  };
  const patchPromise = (async () => {
    try {
      const patched = await patchChatSessionSettings(
        host,
        targetSessionKey,
        {
          thinkingLevel: normalizedNext ?? null,
        },
        {
          ...scopedAgentParamsForSession(host, targetSessionKey),
          reconcile: async () => refreshCurrentChatSessionList(host),
        },
      );
      if (!patched) {
        rollback();
        return false;
      }
      if (isCurrentChatSettingsPatch(chatThinkingPatchTokens, host, targetSessionKey, token)) {
        patchSessionRow(host, targetSessionKey, { thinkingLevel: normalizedNext });
        if (host.sessionKey === targetSessionKey) {
          host.chatThinkingLevel = normalizedNext ?? null;
        }
      }
      return true;
    } catch (err) {
      rollback();
      setChatError(host, `Failed to set thinking level: ${formatUiError(err)}`, true);
      return false;
    }
  })();
  return patchPromise;
}

export function switchChatContextWindow(
  host: ChatModelSettingsHost,
  nextContextWindow: string,
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const activeRow = host.sessionsResult?.sessions?.find((row) =>
    areUiSessionKeysEquivalent(row.key, targetSessionKey),
  );
  const previous = activeRow?.contextWindow;
  const next = nextContextWindow.trim() || undefined;
  if ((previous ?? "") === (next ?? "")) {
    return Promise.resolve(true);
  }
  const token = claimChatSettingsPatch(chatContextWindowPatchTokens, host, targetSessionKey);
  setChatError(host, null, true);
  patchSessionRow(host, targetSessionKey, { contextWindow: next });
  const rollback = () => {
    if (isCurrentChatSettingsPatch(chatContextWindowPatchTokens, host, targetSessionKey, token)) {
      patchSessionRow(host, targetSessionKey, { contextWindow: previous });
    }
  };
  return (async () => {
    try {
      const patched = await patchChatSessionSettings(
        host,
        targetSessionKey,
        { contextWindow: next ?? null },
        {
          ...scopedAgentParamsForSession(host, targetSessionKey),
          reconcile: async () => refreshCurrentChatSessionList(host),
        },
      );
      if (!patched) {
        rollback();
        return false;
      }
      return true;
    } catch (err) {
      rollback();
      setChatError(host, `Failed to set context window: ${formatUiError(err)}`, true);
      return false;
    }
  })();
}

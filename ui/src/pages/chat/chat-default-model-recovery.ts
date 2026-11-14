import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import { resolveChatModelSelectValues } from "../../lib/chat/model-select-state.ts";
import {
  isSessionRuntimePinned,
  resolveModelRuntimeEntry,
} from "../../lib/model-runtime-choice.ts";
import type { ChatDefaultModelRecovery } from "./chat-default-model-recovery.types.ts";
import { readChatSettingsTargetRow, switchChatModel } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { readChatModelCatalogState } from "./chat-state-refresh.ts";
import { hasDirectSessionRun } from "./run-lifecycle.ts";

export type { ChatDefaultModelRecovery } from "./chat-default-model-recovery.types.ts";

/** Explicit selection only: never replay a failed prompt or modify its fallback policy. */
export function createChatDefaultModelRecovery(
  host: ChatPageHost,
  options: { readAgentDefaultModel: () => string | undefined; canDispatch: () => boolean },
): ChatDefaultModelRecovery | undefined {
  const sessionKey = host.sessionKey;
  const failure = host.chatRunError;
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  const accountSelection = host.chatAccountSelection;
  const agentInventory = host.agentsList;
  if (host.chatModelSwitchPromises[sessionKey]) {
    return undefined;
  }
  const readTarget = (ownSelectionPending = false) => {
    const row = readChatSettingsTargetRow(host, sessionKey);
    const catalog = readChatModelCatalogState(host);
    if (
      !failure ||
      failure.kind ||
      host.chatRunError !== failure ||
      host.sessionKey !== sessionKey ||
      !host.connected ||
      host.client !== client ||
      host.connectionEpoch !== connectionEpoch ||
      host.chatAccountSelection !== accountSelection ||
      host.agentsList !== agentInventory ||
      hasDirectSessionRun(host) ||
      host.chatSending ||
      host.chatStream !== null ||
      !row?.sessionId ||
      row.modelSelectionLocked ||
      row.archived ||
      row.providerReview ||
      !catalog.hasSnapshot ||
      catalog.status !== "ready" ||
      catalog.retired ||
      catalog.initialized === false ||
      !options.canDispatch()
    ) {
      return undefined;
    }
    const { currentOverride, defaultModel } = resolveChatModelSelectValues({
      activeSession: row,
      agentDefaultModel: options.readAgentDefaultModel(),
      modelSelectionPolicy: host.chatModelSelectionPolicy,
      chatModelCatalog: host.chatModelCatalog,
      // The selection owner installs its own optimistic override before dispatch.
      // Its live ownership veto handles newer local intent; recheck saved row facts here.
      modelOverrides: ownSelectionPending ? {} : host.sessions.state.modelOverrides,
      sessionKey,
      sessionsResult: host.sessionsResult ?? null,
    });
    const current = splitTrailingAuthProfile(currentOverride);
    const entry = host.chatModelCatalog.find(
      (candidate) =>
        buildQualifiedChatModelValue(candidate.id, candidate.provider) === defaultModel,
    );
    // Exact provider identity preserves the credential/transport route, not just its brand.
    const selected = host.chatModelCatalog.find(
      (candidate) =>
        buildQualifiedChatModelValue(candidate.id, candidate.provider) === current.model,
    );
    const runtime = resolveModelRuntimeEntry(
      entry,
      isSessionRuntimePinned(row.agentRuntime) ? row.agentRuntime?.id : undefined,
    );
    if (
      !entry ||
      !selected ||
      entry.provider !== selected.provider ||
      current.model === defaultModel ||
      entry.manualSelectionAllowed === false ||
      entry.available !== true ||
      !runtime ||
      runtime.available !== true ||
      runtime.manualSelectionAllowed === false
    ) {
      return undefined;
    }
    return {
      sessionId: row.sessionId,
      currentOverride,
      value: defaultModel + (current.profile ? `@${current.profile}` : ""),
      modelLabel: entry.name,
      runtimeId: row.agentRuntime?.id,
      runtimeSource: row.agentRuntime?.source,
    };
  };
  const target = readTarget();
  if (!target) {
    return undefined;
  }
  const canSwitch = (ownSelectionPending = false) => {
    const current = readTarget(ownSelectionPending);
    return (
      current?.sessionId === target.sessionId &&
      current.currentOverride === target.currentOverride &&
      current.value === target.value &&
      current.runtimeId === target.runtimeId &&
      current.runtimeSource === target.runtimeSource
    );
  };
  return {
    modelLabel: target.modelLabel,
    switchModel: () =>
      canSwitch()
        ? switchChatModel(
            host,
            target.value,
            sessionKey,
            undefined,
            options.readAgentDefaultModel(),
            () => canSwitch(true),
          )
        : Promise.resolve(false),
  };
}

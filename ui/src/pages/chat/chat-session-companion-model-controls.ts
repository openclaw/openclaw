import type { ModelCatalogEntry } from "../../api/types.ts";
import { normalizeChatFastModeInput } from "../../lib/chat/model-select-state.ts";
import type {
  ChatSessionCompanionModelSelection,
  ChatSessionCompanionThread,
} from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  readChatModelCatalogState,
  refreshChatModelCatalogOnDemand,
} from "./chat-state-refresh.ts";
import type { ChatModelControlsProps } from "./components/chat-model-controls.types.ts";

const sideChatCatalogs = new WeakMap<ModelCatalogEntry[], ModelCatalogEntry[]>();

/**
 * Side chat reuses the main composer's model and effort pickers for its own
 * per-question controls. Choices stay in the pane's companion store and travel
 * with each question; they never patch the observed session.
 */
export function createSideChatModelControlProps(params: {
  state: ChatPageHost;
  companion: ChatSessionCompanionThread;
  onSelect: (patch: ChatSessionCompanionModelSelection) => void;
}): ChatModelControlsProps {
  const { state, companion } = params;
  const selection = companion.modelSelection ?? {};
  const sessionKey = `side-chat:${state.sessionKey}`;
  // Side chat always answers on the OpenClaw runtime, so runtime variants are not choices.
  const sourceCatalog = state.chatModelCatalog;
  let catalog = sideChatCatalogs.get(sourceCatalog);
  if (!catalog) {
    catalog = sourceCatalog.map(({ runtimeChoices: _runtimeChoices, ...entry }) => entry);
    sideChatCatalogs.set(sourceCatalog, catalog);
  }
  const modelRef = selection.model || companion.defaultModel || "";
  const separator = modelRef.indexOf("/");
  const effective =
    separator > 0
      ? { provider: modelRef.slice(0, separator), model: modelRef.slice(separator + 1) }
      : { model: modelRef || undefined };
  const entry = catalog.find(
    (candidate) => candidate.provider === effective.provider && candidate.id === effective.model,
  );
  const target = { model: effective.model, modelProvider: effective.provider };
  return {
    activeRunId: null,
    agentDefaultModel: companion.defaultModel,
    connected: state.connected,
    gatewayAvailable: Boolean(state.client),
    loading: false,
    modelCatalog: catalog,
    modelCatalogState: readChatModelCatalogState(state),
    modelOverrides: { [sessionKey]: selection.model ?? null },
    modelSwitching: false,
    sending: companion.turns.some((turn) => turn.status === "pending"),
    sessionKey,
    selectedSession: undefined,
    sessionsResult: null,
    stream: null,
    thinkingSession: { ...target, thinkingLevel: selection.thinkingLevel },
    fastModeTarget: {
      ...target,
      fastMode: selection.fastMode,
      effectiveFastMode: selection.fastMode ?? entry?.effectiveFastMode,
    },
    onModelSelect: (value) => params.onSelect({ model: value || undefined }),
    onThinkingSelect: (value) => params.onSelect({ thinkingLevel: value || undefined }),
    onFastModeSelect: (value) => params.onSelect({ fastMode: normalizeChatFastModeInput(value) }),
    onModelPickerOpen: () => refreshChatModelCatalogOnDemand(state),
  };
}

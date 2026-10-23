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
import type { ChatModelControlsProps } from "./components/chat-model-controls.tsx";

const sideChatCatalogs = new WeakMap<ModelCatalogEntry[], ModelCatalogEntry[]>();

// Side chat always answers on the OpenClaw runtime, so runtime variants are not choices.
function sideChatCatalog(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  let projected = sideChatCatalogs.get(catalog);
  if (!projected) {
    projected = catalog.map(({ runtimeChoices: _runtimeChoices, ...entry }) => entry);
    sideChatCatalogs.set(catalog, projected);
  }
  return projected;
}

function splitModelRef(value: string): { provider?: string; model?: string } {
  const separator = value.indexOf("/");
  return separator > 0
    ? { provider: value.slice(0, separator), model: value.slice(separator + 1) }
    : { model: value || undefined };
}

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
  const catalog = sideChatCatalog(state.chatModelCatalog);
  const effective = splitModelRef(selection.model || companion.defaultModel || "");
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

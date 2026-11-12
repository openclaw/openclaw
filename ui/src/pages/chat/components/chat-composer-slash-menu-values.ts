import { resolveChatModelSelectState } from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import type { ChatPaneModelControl } from "../chat-pane-model-control.tsx";
import { formatEffortLabel } from "./chat-effort-picker.tsx";
import {
  prepareChatModelCatalog,
  resolveChatModelPickerLabel,
} from "./chat-model-catalog-presentation.ts";

export type SlashMenuCurrentValues = Partial<Record<string, { value: string; label: string }>>;

/** Read the same owned selection facts as the composer's model and effort controls. */
export function slashMenuCurrentValues(
  model: Parameters<typeof ChatPaneModelControl>[0]["model"] | undefined,
): SlashMenuCurrentValues {
  if (!model) {
    return {};
  }
  const saved = model.snapshot;
  const catalog = saved ? [saved] : model.modelCatalog;
  const session = saved
    ? { ...saved, model: saved.id, modelProvider: saved.provider }
    : model.thinkingSession;
  const thinking = resolveChatThinkingSelectState({
    catalog,
    session,
    defaults: model.thinkingDefaults,
    sessionKey: model.sessionKey,
    sessionsResult: model.sessionsResult,
  }).selection;
  const selection = resolveChatModelSelectState({
    activeSession: saved ? session : model.selectedSession,
    agentDefaultModel: model.agentDefaultModel,
    chatModelCatalog: catalog,
    modelOverrides: model.modelOverrides ?? {},
    sessionKey: model.sessionKey,
    sessionsResult: model.sessionsResult,
    modelSelectionPolicy: model.modelCatalogState.modelSelectionPolicy,
    catalogRetired: model.modelCatalogState.retired,
    catalogInitialized: model.modelCatalogState.initialized,
  });
  const entries = prepareChatModelCatalog(catalog);
  const state = model.modelCatalogState;
  const current =
    !(state.retired || state.initialized === false || state.modelSelectionPolicy?.restricted) ||
    (!state.retired && entries.entry(selection.currentOverride))
      ? selection.currentOverride
      : "";
  const value = current || selection.defaultModel;
  const entry = entries.entry(value);
  return {
    ...(thinking.value
      ? { think: { value: thinking.value, label: formatEffortLabel(thinking.displayLabel) } }
      : {}),
    ...(value && !(model.modelSelectionLocked && !current)
      ? {
          model: {
            value,
            label: resolveChatModelPickerLabel(
              entry,
              entry?.name || value,
              model.selectedAgentRuntime ??
                model.selectedSession?.agentRuntime?.id ??
                entry?.agentRuntime?.id ??
                model.sessionsResult?.defaults.agentRuntime?.id,
            ),
          },
        }
      : {}),
  };
}

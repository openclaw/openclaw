import { createMemo, type Accessor } from "solid-js";
import {
  prepareChatModelSelectCatalog,
  resolveChatModelSelectValues,
} from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import type { ChatPaneModelControl } from "../chat-pane-model-control.tsx";
import { formatEffortLabel } from "./chat-effort-picker.tsx";
import {
  prepareChatModelCatalog,
  resolveChatModelPickerLabel,
  resolveChatModelSnapshot,
} from "./chat-model-catalog-presentation.ts";

export type SlashMenuCurrentValues = Partial<Record<string, { value: string; label: string }>>;

export type SlashMenuModel = Parameters<typeof ChatPaneModelControl>[0]["model"];

/** Retain catalog preparation across unrelated composer frames. */
export function createSlashMenuCurrentValues(readModel: Accessor<SlashMenuModel | undefined>) {
  const snapshot = createMemo(() => readModel()?.snapshot);
  const sessionKey = createMemo(() => readModel()?.sessionKey ?? "");
  const saved = createMemo(() => resolveChatModelSnapshot(snapshot(), sessionKey()));
  const catalog = createMemo(() => saved()?.catalog ?? readModel()?.modelCatalog ?? []);
  const entries = createMemo(() => prepareChatModelCatalog(catalog()));
  const selectionCatalog = createMemo(() => prepareChatModelSelectCatalog(catalog()));
  return createMemo((): SlashMenuCurrentValues => {
    const model = readModel();
    if (!model) {
      return {};
    }
    const state = saved()?.catalogState ?? model.modelCatalogState;
    const session = saved()?.thinkingSession ?? model.thinkingSession;
    const thinking = resolveChatThinkingSelectState({
      catalog: catalog(),
      session,
      defaults: model.thinkingDefaults,
      sessionKey: model.sessionKey,
      sessionsResult: model.sessionsResult,
    }).selection;
    const selection = resolveChatModelSelectValues(
      {
        activeSession: saved()?.session ?? model.selectedSession,
        agentDefaultModel: model.agentDefaultModel,
        chatModelCatalog: catalog(),
        modelOverrides: model.modelOverrides ?? {},
        sessionKey: model.sessionKey,
        sessionsResult: model.sessionsResult,
        modelSelectionPolicy: state.modelSelectionPolicy,
        catalogRetired: state.retired,
        catalogInitialized: state.initialized,
      },
      selectionCatalog().options,
    );
    const current =
      !(state.retired || state.initialized === false || state.modelSelectionPolicy?.restricted) ||
      (!state.retired && entries().entry(selection.currentOverride))
        ? selection.currentOverride
        : "";
    const value = current || selection.defaultModel;
    const entry = entries().entry(value);
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
  });
}

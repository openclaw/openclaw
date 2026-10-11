import { t } from "../../../i18n/index.ts";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import { solidTemplate } from "./chat-composer-controls.ts";
import { ChatModelCatalogRefresh, ChatModelCatalogState } from "./chat-model-catalog-state.tsx";
import type { ChatModelCatalogStateProps } from "./chat-model-types.ts";

export function renderChatModelCatalogRefresh(state: ModelCatalogState | undefined) {
  return solidTemplate(ChatModelCatalogRefresh, { state });
}

export function renderChatModelCatalogState(
  state: ModelCatalogState | undefined,
  hasOptions: boolean,
  hasSelectableOptions: boolean,
  onModelSetup?: () => void,
  errorLabel = t("chat.modelControls.modelsUnavailable"),
  retryTarget?: ChatModelCatalogStateProps["retryTarget"],
  emptyLabel?: string,
) {
  return solidTemplate(ChatModelCatalogState, {
    state,
    hasOptions,
    hasSelectableOptions,
    onModelSetup,
    errorLabel,
    retryTarget,
    emptyLabel,
  });
}

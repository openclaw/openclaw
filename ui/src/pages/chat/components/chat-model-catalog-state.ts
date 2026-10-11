import { t } from "../../../i18n/index.ts";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import { solidTemplate } from "./chat-composer-interop.tsx";
import { ChatModelCatalogRefresh, ChatModelCatalogState } from "./chat-model-catalog-state.tsx";

export type ChatModelCatalogStateProps = {
  state: ModelCatalogState | undefined;
  hasOptions: boolean;
  hasSelectableOptions: boolean;
  onModelSetup?: () => void;
  errorLabel?: string;
  retryTarget?: { disabled: boolean; groupId: string; onRetry: (groupId: string) => unknown };
  emptyLabel?: string;
};

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

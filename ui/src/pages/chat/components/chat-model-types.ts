import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";

export type ChatModelAccountSectionViewProps = ReturnType<ChatModelAccountSection["viewProps"]>;

export type ChatModelCatalogStateProps = {
  state: ModelCatalogState | undefined;
  hasOptions: boolean;
  hasSelectableOptions: boolean;
  onModelSetup?: () => void;
  errorLabel?: string;
  retryTarget?: { disabled: boolean; groupId: string; onRetry: (groupId: string) => unknown };
  emptyLabel?: string;
};

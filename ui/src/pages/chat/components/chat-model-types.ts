import type { ChatAccountSelection } from "../../../../../packages/gateway-protocol/src/index.ts";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";

export type ChatModelAccountSectionViewProps = {
  selectionKind: ChatAccountSelection["kind"];
  disabled: boolean;
  selectedIdentity: string;
  options: readonly { value: string; label: string; description?: string; disabled?: boolean }[];
  currentValue: string;
  open: boolean;
  error: string | null;
  startIndex: number;
  onToggle: () => void;
  onSelect: (value: string, event: MouseEvent) => void;
};

export type ChatModelCatalogStateProps = {
  state: ModelCatalogState | undefined;
  hasOptions: boolean;
  hasSelectableOptions: boolean;
  onModelSetup?: () => void;
  errorLabel?: string;
  retryTarget?: { disabled: boolean; groupId: string; onRetry: (groupId: string) => unknown };
  emptyLabel?: string;
};

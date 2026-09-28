import type { TemplateResult } from "lit";
import type { ChatPendingInputsPage } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { AssistantMessageExpansionState } from "../chat-message-recovery.ts";

/** Display-only saved attempts, never members of the runnable outbox. */
export type ChatQueueRecovery = {
  items: readonly ChatPendingInputsPage["items"][number][];
  busyIds?: ReadonlySet<string>;
  error?: string;
  onSend?: (id: string) => void;
  onDiscard: (id: string) => void;
  expandedIds?: ReadonlySet<string>;
  inspections?: ReadonlyMap<string, AssistantMessageExpansionState>;
  onToggle?: (id: string, open: boolean) => void;
  renderDetails?: (
    input: ChatQueueRecovery["items"][number],
    inspection?: AssistantMessageExpansionState,
  ) => TemplateResult;
  paging?: {
    loading: boolean;
    onEarlier?: () => void;
    onLatest?: () => void;
  };
};

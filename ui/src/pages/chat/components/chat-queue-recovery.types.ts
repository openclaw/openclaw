import type { ChatPendingInputsPage } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";

/** Display-only saved attempts, never members of the runnable outbox. */
export type ChatQueueRecovery = {
  items: readonly ChatPendingInputsPage["items"][number][];
  busyIds?: ReadonlySet<string>;
  error?: string;
  onSend?: (id: string) => void;
  onDiscard: (id: string) => void;
  paging?: {
    loading: boolean;
    onEarlier?: () => void;
    onLatest?: () => void;
  };
};

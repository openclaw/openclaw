import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type PendingInputRequest = {
  before?: number;
  kind: "navigation" | "refresh" | "discovery";
  client: GatewayBrowserClient;
  connectionEpoch: number;
};

export type ChatPendingInputView = {
  sessionKey: string;
  sessionId: string | null;
  agentId: string | undefined;
  page: ChatPendingInputsPage;
  /** Live custody receipts keep the queue independent of retained-input pagination. */
  queuedInputs: ChatPendingInputsPage["items"];
  receiptRunIds: string[];
  queuedCount: number;
  queueBefore?: number;
  before?: number;
  readonly loading: boolean;
  error?: string;
  request?: PendingInputRequest;
  /** Optimistic dismissals keyed to the request that owns each; failure restores only its own. */
  dismissing?: ReadonlyMap<string, object>;
  /** Gateway-confirmed dismissals hide late pages read before the tombstone committed. */
  dismissed?: ReadonlySet<string>;
};

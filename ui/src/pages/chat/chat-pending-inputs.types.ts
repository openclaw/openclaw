import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type PendingInputReceiptState =
  | "unknown"
  | "absent"
  | "consumed"
  | "cancelled"
  | "queued"
  | "pending";

export type PendingInputRequest = {
  before?: number;
  kind: "navigation" | "refresh" | "discovery";
  client: GatewayBrowserClient;
  connectionEpoch: number;
  /** Only the current RPC's bounded queried identities; discarded when navigation ends. */
  receiptStates: Map<string, PendingInputReceiptState>;
  /** Advances on semantic disposition changes, not receipt replays. */
  receiptRevision: number;
};

export type ChatPendingInputView = {
  sessionKey: string;
  sessionId: string | null;
  agentId: string | undefined;
  page: ChatPendingInputsPage;
  /** Semantic custody from the latest history publication, independent of the browsed page. */
  custodyKey: string;
  /** Retains semantic transitions even when custody returns to the same key. */
  custodyRevision: number;
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

import type { Selectable } from "kysely";
import type { ApprovalPresentation } from "../../packages/gateway-protocol/src/schema/approvals.js";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/schema/audit-run.js";
import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import type {
  DB as OpenClawStateKyselyDatabase,
  OperatorApprovals,
} from "../state/openclaw-state-db.generated.js";

export type OperatorApprovalKind = "exec" | "plugin" | "system-agent";
export type OperatorApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "cancelled";
export type OperatorApprovalDecision = "allow-once" | "allow-always" | "deny";
export type OperatorApprovalTerminalReason =
  | "user"
  | "timeout"
  | "malformed-verdict"
  | "no-route"
  | "run-aborted"
  | "gateway-restart"
  | "storage-corrupt";
export type OperatorApprovalResolverKind = "device" | "channel" | "runtime" | "system";
type OperatorApprovalRequester = {
  deviceId: string | null;
  clientId: string | null;
  deviceTokenAuth: boolean;
};

type OperatorApprovalSource = {
  agentId: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  runId: string | null;
  toolCallId: string | null;
  toolName: string | null;
};

export type OperatorApprovalResolver = {
  kind: OperatorApprovalResolverKind;
  id: string | null;
};

export type OperatorApprovalRecord = {
  id: string;
  resolutionRef: string;
  kind: OperatorApprovalKind;
  status: OperatorApprovalStatus;
  presentation: ApprovalPresentation;
  requester: OperatorApprovalRequester;
  reviewerDeviceIds: string[];
  source: OperatorApprovalSource;
  audienceSessionKeys: string[];
  runtimeEpoch: string;
  createdAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
  decision: OperatorApprovalDecision | null;
  terminalReason: OperatorApprovalTerminalReason | null;
  resolvedAtMs: number | null;
  resolver: OperatorApprovalResolver | null;
  consumedAtMs: number | null;
  consumedBy: string | null;
};

export type NewOperatorApproval = {
  id: string;
  kind: OperatorApprovalKind;
  presentation: ApprovalPresentation;
  requester?: Partial<OperatorApprovalRequester>;
  reviewerDeviceIds?: readonly string[];
  source?: Partial<OperatorApprovalSource>;
  audienceSessionKeys?: readonly string[];
  runtimeEpoch: string;
  createdAtMs: number;
  expiresAtMs: number;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
};

export type InsertOperatorApprovalResult =
  | { outcome: "inserted"; record: OperatorApprovalRecord }
  | { outcome: "existing"; record: OperatorApprovalRecord }
  | { outcome: "conflict" };

export type GetOperatorApprovalResult =
  | { outcome: "found"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt"; id?: string };

export type ResolveOperatorApprovalResult =
  | { outcome: "resolved"; record: OperatorApprovalRecord }
  | { outcome: "expired"; record: OperatorApprovalRecord }
  | {
      outcome: "already-resolved";
      retry: "same" | "conflict";
      record: OperatorApprovalRecord;
    }
  | { outcome: "decision-not-allowed"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt" };

export type ForceDenyOperatorApprovalResult =
  | { outcome: "denied"; record: OperatorApprovalRecord }
  | { outcome: "expired"; record: OperatorApprovalRecord }
  | { outcome: "not-due"; record: OperatorApprovalRecord }
  | { outcome: "already-terminal"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt" };

export type ConsumeOperatorApprovalResult =
  | { outcome: "consumed"; record: OperatorApprovalRecord }
  | { outcome: "already-consumed"; record: OperatorApprovalRecord }
  | { outcome: "redemption-expired"; record: OperatorApprovalRecord }
  | { outcome: "not-allow-once"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt" };

export type TerminalizeOperatorApprovalsResult = {
  affected: number;
  records: OperatorApprovalRecord[];
};

export type OperatorApprovalDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "operator_approvals" | "operator_approval_execution_identities"
>;
export type OperatorApprovalRow = Selectable<OperatorApprovals>;

export type OperatorApprovalHistoryCursor = {
  resolvedAtMs: number;
  id: string;
};

export type ListTerminalOperatorApprovalsResult = {
  records: OperatorApprovalRecord[];
  nextCursor?: string;
};

export type OperatorApprovalReceiptContext = {
  contextId: string;
  executionId: string;
  runId: string;
};
export type OperatorApprovalReceiptRow = OperatorApprovalRow & {
  binding_context_id: string | null;
  binding_execution_id: string | null;
};
export type OperatorApprovalReceiptCursor = { occurredAt: number; rowId: number };
export type OperatorApprovalReceiptSnapshotRow = Omit<
  OperatorApprovalReceiptRow,
  "presentation_json" | "reviewer_device_ids_json" | "audience_session_keys_json"
> & {
  presentation_json: string | null;
  reviewer_device_ids_json: string | null;
  audience_session_keys_json: string | null;
  receipt_rowid: number;
  payload_bytes: number;
};
export type OperatorApprovalReceiptSnapshotQueryRow = OperatorApprovalReceiptSnapshotRow & {
  cursor_boundary_rowid: number | null;
  page_present: 0 | 1;
};
type OperatorApprovalReceiptPageEntry = {
  receipt: DecisionReceiptV1;
  selectorId: string;
};
export type OperatorApprovalReceiptPage = {
  entries: OperatorApprovalReceiptPageEntry[];
  nextCursor?: OperatorApprovalReceiptCursor;
};
export type OperatorApprovalExecutionLinkState = "exact" | "missing" | "malformed" | "mismatch";

export type ListTerminalOperatorApprovalsInput = {
  cursor?: string;
  limit?: number;
  kind?: OperatorApprovalKind;
  nowMs?: number;
};

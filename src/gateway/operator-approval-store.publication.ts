import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { createStateDomainPublication } from "../state/state-domain-publication.js";
import type { OperatorApprovalRow } from "./operator-approval-store.types.js";

export const operatorApprovalPublication = createStateDomainPublication<OperatorApprovalRow>({
  domain: "operator-approvals",
  keyOf: (row) => row.approval_id,
  isValue: (value): value is OperatorApprovalRow =>
    isRecord(value) &&
    [
      "approval_id",
      "resolution_ref",
      "kind",
      "status",
      "presentation_json",
      "reviewer_device_ids_json",
      "audience_session_keys_json",
      "runtime_epoch",
    ].every((key) => typeof value[key] === "string") &&
    [
      "requested_by_device_id",
      "requested_by_client_id",
      "source_agent_id",
      "source_session_key",
      "source_session_id",
      "source_run_id",
      "source_tool_call_id",
      "source_tool_name",
      "decision",
      "terminal_reason",
      "resolver_kind",
      "resolver_id",
      "consumed_by",
    ].every((key) => value[key] === null || typeof value[key] === "string") &&
    ["created_at_ms", "expires_at_ms", "updated_at_ms", "requested_by_device_token_auth"].every(
      (key) => typeof value[key] === "number",
    ) &&
    ["resolved_at_ms", "consumed_at_ms"].every(
      (key) => value[key] === null || typeof value[key] === "number",
    ),
});

type StandingGrantRow = Selectable<DB["operator_approval_standing_grants"]>;
export const operatorStandingGrantPublication = createStateDomainPublication<StandingGrantRow>({
  domain: "operator-standing-grants",
  keyOf: (row) => row.grant_id,
  isValue: (value): value is StandingGrantRow =>
    isRecord(value) &&
    [
      "grant_id",
      "minted_by_approval_id",
      "agent_id",
      "cron_job_id",
      "job_config_revision",
      "operation_binding",
    ].every((key) => typeof value[key] === "string") &&
    ["created_at_ms", "use_count"].every((key) => typeof value[key] === "number") &&
    ["expires_at_ms", "revoked_at_ms", "last_used_at_ms"].every(
      (key) => value[key] === null || typeof value[key] === "number",
    ) &&
    (value.revoked_by === null || typeof value.revoked_by === "string"),
});

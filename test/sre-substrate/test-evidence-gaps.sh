#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
# shellcheck source=/dev/null
source "$ROOT/lib-evidence-gaps.sh"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

cat >"$TMP" <<'EOF'
deploy_gaps=1
image_revision=0
ci_signal=1
argocd_sync=0
changes_in_window=1
EOF

OUTPUT="$(evidence_gaps_assess bad_deploy "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "bad_deploy"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["image_revision"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["argocd_sync"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 23' >/dev/null

cat >"$TMP" <<'EOF'
critical_alerts=1
log_signals=1
db_schema_check=1
db_data_check=0
pg_internal_check=1
incident_memory=1
changes_in_window=0
config_lineage=1
replica_lag=0
pg_activity=1
pg_statements=0
pg_conflicts=1
db_topology=1
EOF

OUTPUT="$(evidence_gaps_assess data_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "data_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["db_data_check"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["changes_in_window","replica_lag","pg_statements"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 33' >/dev/null

cat >"$TMP" <<'EOF'
critical_alerts=1
log_signals=1
db_schema_check=1
db_data_check=0
pg_internal_check=0
incident_memory=1
replica_lag=1
pg_activity=0
pg_statements=0
pg_conflicts=1
db_topology=1
changes_in_window=1
config_lineage=1
EOF

OUTPUT="$(evidence_gaps_assess data_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "data_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["db_data_check","pg_internal_check"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["pg_activity","pg_statements"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 46' >/dev/null

cat >"$TMP" <<'EOF'
critical_alerts=1
log_signals=1
db_schema_check=1
db_data_check=1
pg_internal_check=1
incident_memory=1
changes_in_window=1
config_lineage=1
replica_lag=1
pg_activity=1
pg_statements=1
pg_conflicts=1
db_topology=1
rewards_provider_mode=1
db_row_provenance=1
provider_api_check=1
provider_side_mismatch=1
artifact_check=0
code_path_check=1
code_path_reconciled=1
same_token_both_sides_expected=1
disproved_theory_expected=0
disproved_theory_recorded=0
EOF

OUTPUT="$(evidence_gaps_assess data_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "data_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["artifact_check"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == []' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 18' >/dev/null

cat >"$TMP" <<'EOF'
critical_alerts=1
log_signals=1
db_schema_check=1
db_data_check=1
pg_internal_check=1
incident_memory=1
changes_in_window=1
config_lineage=1
replica_lag=1
pg_activity=1
pg_statements=1
pg_conflicts=1
db_topology=1
rewards_provider_mode=1
db_row_provenance=1
provider_api_check=1
provider_side_mismatch=0
artifact_check=1
code_path_check=1
code_path_reconciled=0
same_token_both_sides_expected=0
disproved_theory_expected=1
disproved_theory_recorded=0
EOF

OUTPUT="$(evidence_gaps_assess data_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "data_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["disproved_theory_recorded"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == []' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 18' >/dev/null

cat >"$TMP" <<'EOF'
critical_alerts=1
log_signals=1
db_schema_check=1
db_data_check=1
pg_internal_check=1
incident_memory=1
changes_in_window=1
config_lineage=1
replica_lag=1
pg_activity=1
pg_statements=1
pg_conflicts=1
db_topology=1
rewards_provider_mode=1
db_row_provenance=1
provider_api_check=1
provider_side_mismatch=1
artifact_check=1
code_path_check=1
code_path_reconciled=0
same_token_both_sides_expected=1
disproved_theory_expected=0
disproved_theory_recorded=0
EOF

OUTPUT="$(evidence_gaps_assess data_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "data_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["code_path_reconciled"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == []' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 18' >/dev/null

cat >"$TMP" <<'EOF'
critical_alerts=1
log_signals=1
db_schema_check=1
db_data_check=1
pg_internal_check=1
incident_memory=1
changes_in_window=1
config_lineage=1
replica_lag=1
pg_activity=1
pg_statements=1
pg_conflicts=1
db_topology=1
rewards_provider_mode=1
db_row_provenance=1
provider_api_check=1
provider_side_mismatch=1
artifact_check=0
code_path_check=1
code_path_reconciled=0
same_token_both_sides_expected=1
disproved_theory_expected=1
disproved_theory_recorded=0
EOF

OUTPUT="$(evidence_gaps_assess data_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "data_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["artifact_check","code_path_reconciled","disproved_theory_recorded"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == []' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 54' >/dev/null

cat >"$TMP" <<'EOF'
pod_issues=1
prom_critical=1
changes_in_window=1
aws_critical=0
db_vs_live_head_gap=1
processed_vs_head_rate_gap=0
metric_blind_spot=1
resources_missing=0
queue_backlog=1
rpc_mismatch=0
recurring_incident=1
EOF

OUTPUT="$(evidence_gaps_assess scaling_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "scaling_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == []' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["aws_critical","processed_vs_head_rate_gap","resources_missing","rpc_mismatch"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 20' >/dev/null

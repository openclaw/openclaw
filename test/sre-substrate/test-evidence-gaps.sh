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
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["changes_in_window","file_truncation_signature","replica_lag","pg_statements"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 38' >/dev/null

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
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["file_truncation_signature","pg_activity","pg_statements"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 51' >/dev/null

cat >"$TMP" <<'EOF'
critical_alerts=0
log_signals=0
db_schema_check=0
db_data_check=0
pg_internal_check=0
incident_memory=0
changes_in_window=0
config_lineage=0
file_truncation_signature=0
replica_lag=0
pg_activity=0
pg_statements=0
pg_conflicts=0
db_topology=0
primary_reported_symptom=Rewards APR shows 0%
explains_primary_symptom=false
EOF

OUTPUT="$(evidence_gaps_assess data_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "data_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '(.missing_critical | index("primary_symptom_unexplained")) != null' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 78' >/dev/null

cat >"$TMP" <<'EOF'
critical_alerts=1
log_signals=1
db_schema_check=1
db_data_check=1
pg_internal_check=1
incident_memory=1
changes_in_window=1
config_lineage=1
file_truncation_signature=1
replica_lag=1
pg_activity=1
pg_statements=1
pg_conflicts=1
db_topology=1
single_vault_graphql_mode=1
exact_query_replay=1
minimal_field_check=0
healthy_control_check=1
public_surface_split=0
direct_rpc_check=1
db_row_provenance=1
job_path_simulation=0
EOF

OUTPUT="$(evidence_gaps_assess data_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "data_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["minimal_field_check","public_surface_split"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["job_path_simulation"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 41' >/dev/null

cat >"$TMP" <<'EOF'
critical_alerts=1
log_signals=1
db_schema_check=1
db_data_check=1
pg_internal_check=1
incident_memory=1
changes_in_window=1
config_lineage=1
file_truncation_signature=1
replica_lag=1
pg_activity=1
pg_statements=1
pg_conflicts=1
db_topology=1
single_vault_graphql_mode=1
rewards_provider_mode=1
exact_query_replay=1
minimal_field_check=1
healthy_control_check=1
public_surface_split=1
direct_rpc_check=1
provider_api_check=1
artifact_check=1
code_path_check=1
job_path_simulation=0
same_token_both_sides_expected=0
disproved_theory_expected=0
EOF

OUTPUT="$(evidence_gaps_assess data_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "data_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["db_row_provenance"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["job_path_simulation"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 23' >/dev/null

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
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["file_truncation_signature"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 23' >/dev/null

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
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["file_truncation_signature"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 23' >/dev/null

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
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["file_truncation_signature"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 23' >/dev/null

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
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["file_truncation_signature"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 59' >/dev/null

cat >"$TMP" <<'EOF'
critical_alerts=1
log_signals=1
db_schema_check=1
db_data_check=1
pg_internal_check=1
incident_memory=1
changes_in_window=1
config_lineage=1
file_truncation_signature=1
replica_lag=1
pg_activity=1
pg_statements=1
pg_conflicts=1
db_topology=1
rewards_provider_mode=1
rewards_provider_live_probe_expected=1
primary_symptom_replay=1
provider_entity_liveness=0
db_row_provenance=1
provider_api_check=1
artifact_check=1
code_path_check=1
same_token_both_sides_expected=0
disproved_theory_expected=0
EOF

OUTPUT="$(evidence_gaps_assess data_issue "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "data_issue"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["provider_entity_liveness"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == []' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 18' >/dev/null

cat >"$TMP" <<'EOF'
sentry_event_trace=1
abi_encoding_verification=1
commit_diff_review=0
affected_token_enumeration=1
foundry_test_reproduction=0
incident_memory=1
ci_signal=0
EOF

OUTPUT="$(evidence_gaps_assess sdk_regression "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "sdk_regression"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["commit_diff_review"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["foundry_test_reproduction","ci_signal"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 28' >/dev/null

cat >"$TMP" <<'EOF'
sentry_event_trace=0
abi_encoding_verification=0
commit_diff_review=0
affected_token_enumeration=0
foundry_test_reproduction=0
incident_memory=0
ci_signal=0
EOF

OUTPUT="$(evidence_gaps_assess sdk_regression "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "sdk_regression"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["sentry_event_trace","abi_encoding_verification","commit_diff_review"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["affected_token_enumeration","foundry_test_reproduction","incident_memory","ci_signal"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 60' >/dev/null

cat >"$TMP" <<'EOF'
sentry_event_trace=1
abi_encoding_verification=1
commit_diff_review=1
affected_token_enumeration=1
foundry_test_reproduction=1
incident_memory=1
ci_signal=1
EOF

OUTPUT="$(evidence_gaps_assess sdk_regression "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "sdk_regression"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == []' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == []' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 0' >/dev/null

cat >"$TMP" <<'EOF'
pod_issues=1
prom_critical=1
log_signals=0
argocd_sync=1
changes_in_window=0
image_revision=1
EOF

OUTPUT="$(evidence_gaps_assess resource_exhaustion "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "resource_exhaustion"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == []' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["log_signals","changes_in_window"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 10' >/dev/null

cat >"$TMP" <<'EOF'
pod_issues=0
prom_critical=1
log_signals=1
argocd_sync=0
changes_in_window=0
image_revision=0
EOF

OUTPUT="$(evidence_gaps_assess resource_exhaustion "$TMP")"

printf '%s\n' "$OUTPUT" | jq -e '.category == "resource_exhaustion"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_critical == ["pod_issues"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.missing_optional == ["argocd_sync","changes_in_window","image_revision"]' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.confidence_penalty == 33' >/dev/null

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

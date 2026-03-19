#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
# shellcheck source=/dev/null
source "$ROOT/lib-hypothesis-recollect.sh"

gap_json='{"missing_critical":["deploy_gaps","config_drift"],"missing_optional":["changes_in_window"]}'
db_gap_json='{"missing_critical":["db_schema_check","pg_internal_check"],"missing_optional":["pg_statements"]}'
primary_gap_json='{"missing_critical":["primary_symptom_unexplained"],"missing_optional":[]}'

hypothesis_recollect_should_run 55 "$gap_json" 0 1000 bad_deploy
hypothesis_recollect_should_run 92 "$gap_json" 0 1000 bad_deploy
! hypothesis_recollect_should_run 55 "$gap_json" 2 1000 bad_deploy
! hypothesis_recollect_should_run 55 '{"missing_critical":[]}' 0 1000 bad_deploy
! hypothesis_recollect_should_run 55 "$gap_json" 0 20000 bad_deploy

collectors="$(hypothesis_recollect_collectors "$gap_json" bad_deploy)"
printf '%s\n' "$collectors" | rg '^step_01_pod_deploy$' >/dev/null
printf '%s\n' "$collectors" | rg '^collect_phase2_drift_and_lineage$' >/dev/null

db_collectors="$(hypothesis_recollect_collectors "$db_gap_json" data_issue)"
printf '%s\n' "$db_collectors" | rg '^collect_phase2_db_evidence$' >/dev/null

rewards_gap_json='{"missing_critical":["db_row_provenance","provider_api_check","provider_side_mismatch","artifact_check","code_path_check","code_path_reconciled","disproved_theory_recorded"],"missing_optional":[]}'
rewards_collectors="$(hypothesis_recollect_collectors "$rewards_gap_json" data_issue)"
test -z "$rewards_collectors"
! hypothesis_recollect_should_run 55 "$rewards_gap_json" 0 1000 data_issue

primary_collectors="$(hypothesis_recollect_collectors "$primary_gap_json" data_issue)"
printf '%s\n' "$primary_collectors" | rg '^step_02_events_alerts$' >/dev/null
printf '%s\n' "$primary_collectors" | rg '^collect_phase2_db_evidence$' >/dev/null
printf '%s\n' "$primary_collectors" | rg '^collect_change_window_context$' >/dev/null
printf '%s\n' "$primary_collectors" | rg '^collect_phase2_rewards_provider_context_if_available$' >/dev/null
hypothesis_recollect_should_run 55 "$primary_gap_json" 0 1000 data_issue

resource_collectors="$(hypothesis_recollect_collectors "$primary_gap_json" resource_exhaustion)"
printf '%s\n' "$resource_collectors" | rg '^step_01_pod_deploy$' >/dev/null
printf '%s\n' "$resource_collectors" | rg '^step_03_prometheus_trends$' >/dev/null
! printf '%s\n' "$resource_collectors" | rg '^collect_phase2_rewards_provider_context_if_available$' >/dev/null

cert_collectors="$(hypothesis_recollect_collectors "$primary_gap_json" cert_or_secret_expiry)"
printf '%s\n' "$cert_collectors" | rg '^step_06_cert_secret_health$' >/dev/null
printf '%s\n' "$cert_collectors" | rg '^collect_phase2_drift_and_lineage$' >/dev/null

network_collectors="$(hypothesis_recollect_collectors "$primary_gap_json" network_connectivity)"
printf '%s\n' "$network_collectors" | rg '^step_02_events_alerts$' >/dev/null
printf '%s\n' "$network_collectors" | rg '^step_07_aws_resource_signals$' >/dev/null
printf '%s\n' "$network_collectors" | rg '^collect_change_window_context$' >/dev/null

note="$(hypothesis_recollect_note bad_deploy "$gap_json" 1)"
printf '%s\n' "$note" | rg 'missing critical evidence' >/dev/null

db_gap_json='{"missing_critical":["db_schema_check","pg_internal_check"],"missing_optional":["pg_conflicts"]}'
db_collectors="$(hypothesis_recollect_collectors "$db_gap_json" data_issue)"
printf '%s\n' "$db_collectors" | rg '^collect_phase2_db_evidence$' >/dev/null

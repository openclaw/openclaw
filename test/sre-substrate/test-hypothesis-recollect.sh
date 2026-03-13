#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
# shellcheck source=/dev/null
source "$ROOT/lib-hypothesis-recollect.sh"

gap_json='{"missing_critical":["deploy_gaps","config_drift"],"missing_optional":["changes_in_window"]}'
db_gap_json='{"missing_critical":["db_schema_check","pg_internal_check"],"missing_optional":["pg_statements"]}'

hypothesis_recollect_should_run 55 "$gap_json" 0 1000
hypothesis_recollect_should_run 92 "$gap_json" 0 1000
! hypothesis_recollect_should_run 55 "$gap_json" 2 1000
! hypothesis_recollect_should_run 55 '{"missing_critical":[]}' 0 1000
! hypothesis_recollect_should_run 55 "$gap_json" 0 20000

collectors="$(hypothesis_recollect_collectors "$gap_json")"
printf '%s\n' "$collectors" | rg '^step_01_pod_deploy$' >/dev/null
printf '%s\n' "$collectors" | rg '^collect_phase2_drift_and_lineage$' >/dev/null

db_collectors="$(hypothesis_recollect_collectors "$db_gap_json")"
printf '%s\n' "$db_collectors" | rg '^collect_phase2_db_evidence$' >/dev/null

rewards_gap_json='{"missing_critical":["provider_api_check","artifact_check","code_path_check","disproved_theory_recorded"],"missing_optional":[]}'
rewards_collectors="$(hypothesis_recollect_collectors "$rewards_gap_json")"
test -z "$rewards_collectors"
! hypothesis_recollect_should_run 55 "$rewards_gap_json" 0 1000

note="$(hypothesis_recollect_note bad_deploy "$gap_json" 1)"
printf '%s\n' "$note" | rg 'missing critical evidence' >/dev/null

db_gap_json='{"missing_critical":["db_schema_check","pg_internal_check"],"missing_optional":["pg_conflicts"]}'
db_collectors="$(hypothesis_recollect_collectors "$db_gap_json")"
printf '%s\n' "$db_collectors" | rg '^collect_phase2_db_evidence$' >/dev/null

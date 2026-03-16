#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_SCRIPT="$REPO_ROOT/skills/morpho-sre/sentinel-triage.sh"
REWARDS_PROVIDER_LIB="$REPO_ROOT/skills/morpho-sre/lib-rewards-provider-evidence.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-sre-sentinel-regressions.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

PARTIAL_SCRIPT="$TMP_ROOT/sentinel-triage.partial.sh"
END_LINE="$(grep -n '^emit_abort_output' "$TARGET_SCRIPT" | head -1 | cut -d: -f1)"
DB_EVIDENCE_START_LINE="$(grep -n '^db_evidence_should_collect' "$TARGET_SCRIPT" | head -1 | cut -d: -f1)"
DB_EVIDENCE_END_LINE="$(grep -n '^build_phase3_gap_input_file' "$TARGET_SCRIPT" | head -1 | cut -d: -f1)"
test -n "$END_LINE"
test -n "$DB_EVIDENCE_START_LINE"
test -n "$DB_EVIDENCE_END_LINE"
sed -n "1,$((END_LINE - 1))p" "$TARGET_SCRIPT" >"$PARTIAL_SCRIPT"
sed -n "${DB_EVIDENCE_START_LINE},$((DB_EVIDENCE_END_LINE - 1))p" "$TARGET_SCRIPT" >>"$PARTIAL_SCRIPT"

export K8S_CONTEXT=test-context
test -r "$REWARDS_PROVIDER_LIB"
# shellcheck source=/dev/null
source "$REWARDS_PROVIDER_LIB"

# shellcheck source=/dev/null
source "$PARTIAL_SCRIPT"

declare -f collect_phase2_rewards_provider_context | grep -F 'db_row_provenance=0' >/dev/null
HAS_LIB_REWARDS_PROVIDER_EVIDENCE=0
collect_phase2_rewards_provider_context_if_available
if rewards_provider_should_collect_if_available 'merkl reward campaign phantom supplyapr'; then
  exit 1
fi
HAS_LIB_REWARDS_PROVIDER_EVIDENCE=1
case "$(sanitize_signal_line 'artifact Authorization: Bearer secret/token+123=')" in
  *'<redacted>'*)
    ;;
  *)
    exit 1
    ;;
esac
BETTERSTACK_CONTEXT='stale indexer vault data'
alert_rows=""
event_rows=""
log_signal_rows=""
pod_rows=""
container_state_rows=""
db_evidence_should_collect
test "$(db_evidence_target_guess 'merkl reward campaign phantom supplyapr')" = 'blue_api'

standalone_rewards_provider_output="$(
  REWARDS_PROVIDER_LIB="$REWARDS_PROVIDER_LIB" bash <<'EOF'
set -euo pipefail
source "$REWARDS_PROVIDER_LIB"
BETTERSTACK_CONTEXT='Merkl reward campaign mismatch'
alert_rows=""
event_rows=""
log_signal_rows=""
db_evidence_rows=""
repo_map_rows=""
revision_rows=""
ci_rows=""
changes_in_window_summary='artifact Authorization: Bearer secret/token+123='
db_row_provenance_evidence_input=""
provider_api_evidence_input=""
provider_side_mismatch_evidence_input=""
artifact_evidence_input=""
code_path_evidence_input=""
code_path_reconciled_evidence_input=""
disproved_theory_evidence_input=""
collect_phase2_rewards_provider_context
printf '%s\t%s\n' "${artifact_check:-0}" "${artifact_evidence_output:-}"
EOF
)"
test "${standalone_rewards_provider_output%%$'\t'*}" = '1'
case "$standalone_rewards_provider_output" in
  $'1\t'*'<redacted>'*)
    ;;
  *)
    exit 1
    ;;
esac

rewards_provider_has_same_token_signal 'same reward token appears on both supply and borrow'
! rewards_provider_has_same_token_signal 'same reward token appears on supply only'
rewards_provider_has_same_token_signal 'borrow-only reward still shows supply apr'
! rewards_provider_has_same_token_signal 'borrow-only feature has good supply chain security'

date() {
  case "$*" in
    "-u +%M")
      printf '08\n'
      ;;
    "-u +%Y%m%d%H")
      printf '2026031220\n'
      ;;
    *)
      command date "$@"
      ;;
  esac
}

dedup_key="$(compute_dedup_key "monitoring" "incident" "pod-a|pod-b")"
test -n "$dedup_key"
test "$dedup_key" = "$(compute_dedup_key "monitoring" "incident" "pod-a|pod-b")"

date() {
  case "$*" in
    "-u +%M")
      printf '38\n'
      ;;
    "-u +%Y%m%d%H")
      printf '2026031220\n'
      ;;
    *)
      command date "$@"
      ;;
  esac
}

dedup_key_half_30="$(compute_dedup_key "monitoring" "incident" "pod-a|pod-b")"
test -n "$dedup_key_half_30"
test "$dedup_key" != "$dedup_key_half_30"

test "$(normalize_json_compact_or '{"ok":true}' '{}')" = '{"ok":true}'
test "$(normalize_json_compact_or 'not-json' '{}')" = '{}'
test "$(normalize_json_compact_or '' '{}')" = '{}'
test "$(normalize_json_number_or '12.5' 0)" = '12.5'
test "$(normalize_json_number_or 'oops' 0)" = '0'
test "$(normalize_json_number_or '' 0)" = '0'
test "$(normalize_json_number_or '-3' 0)" = '-3'

BETTERSTACK_CONTEXT='Merkl reward campaign mismatch with phantom supplyApr'
alert_rows=""
event_rows=""
log_signal_rows=""
pod_rows=""
container_state_rows=""
db_evidence_should_collect
test "$(db_evidence_target_guess 'merkl reward campaign phantom supplyapr')" = 'blue_api'

repo_map_rows=$'morpho-prd\tpod-a\timage-a\tmorpho-org/morpho-api\t/tmp/morpho-api\tmapping'
revision_rows=$'morpho-prd\tpod-a\timage-a\tmorpho-org/morpho-api\ttag\tcommit\tcommit\t2026-03-12T20:00:00Z\tsubject\t2742\ttitle\tOPEN\thttps://example.com'
ci_rows=$'morpho-org/morpho-api\tworkflow\t42\tcompleted\tsuccess\tdev\tdeadbeef\t2026-03-12T20:00:00Z\thttps://example.com'
changes_in_window_summary='artifact cache refresh landed before incident'
provider_api_evidence_input=""
artifact_evidence_input=""
code_path_evidence_input=""
disproved_theory_evidence_input=""
collect_phase2_rewards_provider_context
test "${rewards_provider_mode:-0}" = '1'
test "${db_row_provenance:-0}" = '0'
test "${provider_api_check:-0}" = '0'
test "${provider_side_mismatch:-0}" = '1'
test "${artifact_check:-0}" = '1'
test "${code_path_check:-0}" = '0'
test "${code_path_reconciled:-0}" = '0'
test "${disproved_theory_recorded:-0}" = '0'
test "${disproved_theory_expected:-0}" = '0'
test "${same_token_both_sides_expected:-0}" = '1'

BETTERSTACK_CONTEXT='pod OOM crash in indexer'
collect_phase2_rewards_provider_context
test "${rewards_provider_mode:-0}" = '0'

BETTERSTACK_CONTEXT='Merkl API campaign mismatch with phantom supplyApr'
collect_phase2_rewards_provider_context
test "${provider_api_check:-0}" = '0'

BETTERSTACK_CONTEXT='GET /v4/opportunities/campaigns?chainId=8453 and apps/api/src/rewards/read-market-rewards.ts:41'
artifact_evidence_input=""
provider_api_evidence_input=""
code_path_evidence_input=""
provider_side_mismatch_evidence_input=""
code_path_reconciled_evidence_input=""
disproved_theory_evidence_input=""
collect_phase2_rewards_provider_context
test "${provider_api_check:-0}" = '1'
test "${code_path_check:-0}" = '1'
test "${code_path_reconciled:-0}" = '0'
test "${same_token_both_sides_expected:-0}" = '0'

BETTERSTACK_CONTEXT='See example.com/foo/bar.ts and not-a-repo path only'
artifact_evidence_input=""
provider_api_evidence_input=""
code_path_evidence_input=""
provider_side_mismatch_evidence_input=""
code_path_reconciled_evidence_input=""
disproved_theory_evidence_input=""
collect_phase2_rewards_provider_context
test "${code_path_check:-0}" = '0'

BETTERSTACK_CONTEXT='Merkl reward campaign mismatch after wrong fix in deployment'
artifact_evidence_input=""
provider_api_evidence_input=""
code_path_evidence_input=""
provider_side_mismatch_evidence_input=""
code_path_reconciled_evidence_input=""
disproved_theory_evidence_input=""
collect_phase2_rewards_provider_context
test "${rewards_provider_mode:-0}" = '1'
test "${disproved_theory_expected:-0}" = '1'
test "${disproved_theory_recorded:-0}" = '0'

BETTERSTACK_CONTEXT='Merkl reward campaign mismatch; PR created and opened PR for config patch'
artifact_evidence_input=""
provider_api_evidence_input=""
code_path_evidence_input=""
provider_side_mismatch_evidence_input=""
code_path_reconciled_evidence_input=""
disproved_theory_evidence_input=""
collect_phase2_rewards_provider_context
test "${rewards_provider_mode:-0}" = '1'
test "${disproved_theory_expected:-0}" = '0'
test "${disproved_theory_recorded:-0}" = '0'

BETTERSTACK_CONTEXT='Merkl reward campaign mismatch; root cause confirmed after direct contract call'
artifact_evidence_input=""
provider_api_evidence_input=""
code_path_evidence_input=""
provider_side_mismatch_evidence_input=""
code_path_reconciled_evidence_input=""
disproved_theory_evidence_input=""
collect_phase2_rewards_provider_context
test "${rewards_provider_mode:-0}" = '1'
test "${disproved_theory_expected:-0}" = '0'
test "${disproved_theory_recorded:-0}" = '0'

db_row_provenance_evidence_input='market_historical_state_rewards row shows supply_apr and borrow_apr for the same OP asset'
provider_api_evidence_input='GET /v4/opportunities/campaigns chainId=8453 returned one MORPHOBORROW campaign'
provider_side_mismatch_evidence_input='borrow-only provider payload still maps to phantom supplyApr in the API response'
artifact_evidence_input='reward snapshot artifact 2026-03-12T20:00Z shows borrow-only campaign persisted'
code_path_evidence_input='apps/api/src/rewards/read-market-rewards.ts:41 consumes market_historical_state_rewards'
code_path_reconciled_evidence_input='morpho-api/apps/processor/src/jobs/markets/processors/market-job-processor.service.ts:635 already merges duplicate assets before persistence'
disproved_theory_evidence_input='provider lookup disproved earlier dbt-drift theory'
collect_phase2_rewards_provider_context
test "${db_row_provenance:-0}" = '1'
test "${provider_api_check:-0}" = '1'
test "${provider_side_mismatch:-0}" = '1'
test "${artifact_check:-0}" = '1'
test "${code_path_check:-0}" = '1'
test "${code_path_reconciled:-0}" = '1'
test "${disproved_theory_recorded:-0}" = '1'
test "${disproved_theory_expected:-0}" = '1'
test "${same_token_both_sides_expected:-0}" = '1'
test "${db_row_provenance_evidence_output:-}" = "$db_row_provenance_evidence_input"
test "${provider_api_evidence_output:-}" = "$provider_api_evidence_input"
test "${provider_side_mismatch_evidence_output:-}" = "$provider_side_mismatch_evidence_input"
test "${artifact_evidence_output:-}" = "$artifact_evidence_input"
test "${code_path_evidence_output:-}" = "$code_path_evidence_input"
test "${code_path_reconciled_evidence_output:-}" = "$code_path_reconciled_evidence_input"
test "${disproved_theory_evidence_output:-}" = "$disproved_theory_evidence_input"

test "$(derive_step11_workloads '' $'morpho-prd\tindexer-base-morpho-abcde\tDeployment/indexer-base-morpho\tRunning\tReady\t0\nmorpho-prd\tindexer-arbitrum-morpho-sh-a1b2c\tDeployment/indexer-arbitrum-morpho-sh\tRunning\tReady\t0\nmorpho-prd\tindexer-base-morpho-f6e7d\tDeployment/indexer-base-morpho\tRunning\tReady\t0')" = 'indexer-arbitrum-morpho-sh|indexer-base-morpho'

ACTIVE_INCIDENTS_FILE="$TMP_ROOT/active-incidents-overlap.tsv"
RESOLVED_INCIDENTS_FILE="$TMP_ROOT/resolved-incidents-overlap.tsv"
cat >"$ACTIVE_INCIDENTS_FILE" <<'EOF'
incident-a	open	monitoring	morpho-prd	200	ack	sev2	fp	note	owner	status	indexer-arbitrum-morpho-sh|indexer-base-morpho
incident-b	open	monitoring	morpho-prd	200	ack	sev2	fp	note	owner	status	indexer-solana-morpho
EOF
cat >"$RESOLVED_INCIDENTS_FILE" <<'EOF'
incident-c	resolved	monitoring	morpho-prd	50	ack	sev2	fp	note	owner	status	indexer-base-morpho|indexer-optimism-morpho
EOF
HAS_LIB_STATE_FILE=0
test "$(count_recent_matching_incidents 'indexer-base-morpho|indexer-optimism-morpho' 100)" = '1'

indexer_freshness_should_collect 'Indexer Delay alert'
indexer_freshness_should_collect 'Indexer Delay on indexer-arbitrum-morpho-sh'

BETTERSTACK_CONTEXT='Indexer Delay on indexer-arbitrum-morpho-sh fires often'
alert_rows='warning	2026-03-12T20:00:00Z	morpho-prd	Indexer Delay'
event_rows=''
pod_rows=$'morpho-prd\tindexer-arbitrum-morpho-sh-abc\tDeployment/indexer-arbitrum-morpho-sh\tRunning\tReady\t0'
container_state_rows=''
log_signal_rows=$'morpho-prd\tindexer-arbitrum-morpho-sh-abc\tindexer\teth_getLogs block not found on the node'
db_evidence_rows=$'summary\tok\tok\t1\tnone\tDB latest block is 1031 blocks / 257s behind live RPC'
changes_in_window_summary='create-historical-rewards-state backlog still running'
revision_rows='no cpu/memory requests configured'
ci_rows='internal sqd lag metric under-reports this failure mode'
deploy_rows=''
ACTIVE_INCIDENTS_FILE="$TMP_ROOT/active-incidents.tsv"
RESOLVED_INCIDENTS_FILE="$TMP_ROOT/resolved-incidents.tsv"
: >"$ACTIVE_INCIDENTS_FILE"
: >"$RESOLVED_INCIDENTS_FILE"
HAS_LIB_STATE_FILE=0
collect_phase2_indexer_freshness_context
test "${indexer_freshness_mode:-0}" = '1'
test "${indexer_db_vs_live_head_gap:-0}" = '1'
test "${indexer_metric_blind_spot:-0}" = '1'
test "${indexer_resources_missing:-0}" = '1'
test "${indexer_queue_backlog:-0}" = '1'
test "${indexer_rpc_mismatch:-0}" = '1'
test "${indexer_recurring_incident:-0}" = '1'
test "${indexer_canonical_category_hint:-unknown}" = 'scaling_issue'
test "${indexer_freshness_note:-disabled}" = 'signals_ready'

CACHE_WRITE_LINE="$(grep -n 'rca_cache_write_json \"${incident_id:-}\"' "$TARGET_SCRIPT" | tail -1 | cut -d: -f1)"
CACHE_WRITE_GUARD_LINE="$(rg -nF 'if [[ "$incident" -eq 1 && "$rca_skip" -eq 0 && -n "${incident_id:-}" && -n "${rca_result_json:-}" ]]' "$TARGET_SCRIPT" | tail -1 | cut -d: -f1)"
CAP_60_LINE="$(grep -n 'Missing critical evidence after recollection; confidence capped at 60' "$TARGET_SCRIPT" | tail -1 | cut -d: -f1)"
CAP_50_LINE="$(grep -n 'Evidence completeness below 60%; confidence capped at 50' "$TARGET_SCRIPT" | tail -1 | cut -d: -f1)"
test -n "$CACHE_WRITE_LINE"
test -n "$CACHE_WRITE_GUARD_LINE"
test -n "$CAP_60_LINE"
test -n "$CAP_50_LINE"
test "$CACHE_WRITE_LINE" -gt "$CAP_60_LINE"
test "$CACHE_WRITE_LINE" -gt "$CAP_50_LINE"
test "$CACHE_WRITE_GUARD_LINE" -le "$CACHE_WRITE_LINE"

rca_result_json='{"merged_confidence":85,"degradation_note":"existing","hypotheses":[{"confidence":85}]}'
rca_confidence=85
apply_rca_confidence_cap 60 'Missing critical evidence after recollection; confidence capped at 60'
test "$rca_confidence" = '60'
test "$(printf '%s\n' "$rca_result_json" | jq -r '.merged_confidence')" = '60'
test "$(printf '%s\n' "$rca_result_json" | jq -r '.hypotheses[0].confidence')" = '60'
test "$(printf '%s\n' "$rca_result_json" | jq -r '.degradation_note')" = 'existing; Missing critical evidence after recollection; confidence capped at 60'

rca_result_json='not-json'
rca_confidence=85
apply_rca_confidence_cap 60 'Missing critical evidence after recollection; confidence capped at 60'
test "$rca_confidence" = '60'

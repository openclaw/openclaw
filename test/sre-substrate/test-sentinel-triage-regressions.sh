#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_SCRIPT="$REPO_ROOT/skills/morpho-sre/sentinel-triage.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-sre-sentinel-regressions.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

PARTIAL_SCRIPT="$TMP_ROOT/sentinel-triage.partial.sh"
END_LINE="$(grep -n '^emit_abort_output' "$TARGET_SCRIPT" | head -1 | cut -d: -f1)"
test -n "$END_LINE"
sed -n "1,$((END_LINE - 1))p" "$TARGET_SCRIPT" >"$PARTIAL_SCRIPT"
REWARDS_START_LINE="$(grep -n '^rewards_provider_should_collect' "$TARGET_SCRIPT" | head -1 | cut -d: -f1)"
REWARDS_END_LINE="$(grep -n '^build_phase3_gap_input_file' "$TARGET_SCRIPT" | head -1 | cut -d: -f1)"
test -n "$REWARDS_START_LINE"
test -n "$REWARDS_END_LINE"
sed -n "${REWARDS_START_LINE},$((REWARDS_END_LINE - 1))p" "$TARGET_SCRIPT" >>"$PARTIAL_SCRIPT"

# shellcheck source=/dev/null
source "$PARTIAL_SCRIPT"

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
test "${provider_api_check:-0}" = '0'
test "${artifact_check:-0}" = '1'
test "${code_path_check:-0}" = '0'
test "${disproved_theory_recorded:-0}" = '0'

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
collect_phase2_rewards_provider_context
test "${provider_api_check:-0}" = '1'
test "${code_path_check:-0}" = '1'

provider_api_evidence_input='GET /v4/opportunities/campaigns chainId=8453 returned one MORPHOBORROW campaign'
artifact_evidence_input='reward snapshot artifact 2026-03-12T20:00Z shows borrow-only campaign persisted'
code_path_evidence_input='apps/api/src/rewards/read-market-rewards.ts:41 consumes market_historical_state_rewards'
disproved_theory_evidence_input='provider lookup disproved earlier dbt-drift theory'
collect_phase2_rewards_provider_context
test "${provider_api_check:-0}" = '1'
test "${artifact_check:-0}" = '1'
test "${code_path_check:-0}" = '1'
test "${disproved_theory_recorded:-0}" = '1'
test "${provider_api_evidence_output:-}" = "$provider_api_evidence_input"
test "${artifact_evidence_output:-}" = "$artifact_evidence_input"
test "${code_path_evidence_output:-}" = "$code_path_evidence_input"
test "${disproved_theory_evidence_output:-}" = "$disproved_theory_evidence_input"

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

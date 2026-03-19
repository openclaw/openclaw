#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"

# shellcheck source=/dev/null
source "$ROOT/lib-rca-chain.sh"

_CHAIN_START_MS="$(_chain_now_ms)"
_CHAIN_CALL_COUNT=2
_CHAIN_STAGES_COMPLETED=(A B E)

assembled="$(
  _chain_assemble_output \
    high \
    '{
      "primary_reported_symptom":"Rewards APR shows 0%",
      "secondary_clues":["provider mismatch"],
      "uncertain_clues":["maybe related stale row"],
      "explicit_human_corrections":["The main issue is provider liveness"],
      "explains_primary_symptom":"yes"
    }' \
    '{
      "hypotheses":[{
        "canonical_category":"data_issue",
        "hypothesis_id":"data_issue:other",
        "description":"provider entity missing",
        "confidence":72,
        "supporting_evidence":["step02:probe"],
        "contradicting_evidence":[]
      }],
      "explains_primary_symptom":"true"
    }' \
    '{
      "causal_chain":{"trigger":"provider entity missing"}
    }' \
    '{}' \
    '{"explains_primary_symptom":"no"}' \
    'A B C D E'
)"

printf '%s\n' "$assembled" | jq -e '.primary_reported_symptom == "Rewards APR shows 0%"' >/dev/null
printf '%s\n' "$assembled" | jq -e '.secondary_clues == ["provider mismatch"]' >/dev/null
printf '%s\n' "$assembled" | jq -e '.uncertain_clues == ["maybe related stale row"]' >/dev/null
printf '%s\n' "$assembled" | jq -e '.explicit_human_corrections == ["The main issue is provider liveness"]' >/dev/null
printf '%s\n' "$assembled" | jq -e '.explains_primary_symptom == false' >/dev/null
printf '%s\n' "$assembled" | jq -e '.chain_metadata.evidence_triage.primary_reported_symptom == "Rewards APR shows 0%"' >/dev/null

assembled_stage_b_fallback="$(
  _chain_assemble_output \
    medium \
    '{}' \
    '{
      "hypotheses":[{
        "canonical_category":"data_issue",
        "hypothesis_id":"data_issue:other",
        "description":"provider mismatch",
        "confidence":15
      }],
      "explains_primary_symptom":"yes"
    }' \
    '{}' \
    '{}' \
    '{}' \
    'A B'
)"

printf '%s\n' "$assembled_stage_b_fallback" | jq -e '.explains_primary_symptom == true' >/dev/null

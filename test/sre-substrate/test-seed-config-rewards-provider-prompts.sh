#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"
PROMPT_LIB="$REPO_ROOT/scripts/sre-runtime/lib-prompts.sh"

jq -e '
  [
    .channels.slack.channels["#platform-monitoring"].systemPrompt,
    .channels.slack.channels["#staging-infra-monitoring"].systemPrompt,
    .channels.slack.channels["#public-api-monitoring"].systemPrompt
  ]
  | unique
  | length == 1
' "$CONFIG" >/dev/null

PROMPT_TEXT="$(
  OPENCLAW_SRE_SKILL_DIR="/home/node/.openclaw/skills/morpho-sre" \
    bash -lc 'source "$1"; build_monitoring_incident_prompt' _ "$PROMPT_LIB"
)"
printf '%s' "$PROMPT_TEXT" | rg -F '_fetchMerklSingleRates()' >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt
  | contains("_fetchMerklSingleRates()")
' "$CONFIG" >/dev/null

printf '%s' "$PROMPT_TEXT" | rg -F 'merged reward row' >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt
  | contains("merged reward row")
' "$CONFIG" >/dev/null

printf '%s' "$PROMPT_TEXT" | rg -F 'If current code, query output, or live evidence disproves an earlier theory' >/dev/null
printf '%s\n' "$PROMPT_TEXT" | grep -Fx 'Monitoring incident intake mode:' >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt
  | contains("If current code, query output, or live evidence disproves an earlier theory")
' "$CONFIG" >/dev/null

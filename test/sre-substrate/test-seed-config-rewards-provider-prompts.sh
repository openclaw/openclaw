#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"
START_GATEWAY="$REPO_ROOT/scripts/sre-runtime/start-gateway.sh"

jq -e '
  [
    .channels.slack.channels["#platform-monitoring"].systemPrompt,
    .channels.slack.channels["#staging-infra-monitoring"].systemPrompt,
    .channels.slack.channels["#public-api-monitoring"].systemPrompt
  ]
  | unique
  | length == 1
' "$CONFIG" >/dev/null

rg -Fq '_fetchMerklSingleRates()' "$START_GATEWAY"

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt
  | contains("_fetchMerklSingleRates()")
' "$CONFIG" >/dev/null

rg -Fq 'merged reward row' "$START_GATEWAY"

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt
  | contains("merged reward row")
' "$CONFIG" >/dev/null

rg -Fq 'If current code, query output, or live evidence disproves an earlier theory' "$START_GATEWAY"

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt
  | contains("If current code, query output, or live evidence disproves an earlier theory")
' "$CONFIG" >/dev/null

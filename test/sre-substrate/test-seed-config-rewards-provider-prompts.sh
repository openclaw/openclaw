#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"

jq -e '
  [
    .channels.slack.channels["#platform-monitoring"].systemPrompt,
    .channels.slack.channels["#staging-infra-monitoring"].systemPrompt,
    .channels.slack.channels["#public-api-monitoring"].systemPrompt
  ]
  | unique
  | length == 1
' "$CONFIG" >/dev/null

jq -e '
  .sre.promptTemplates.monitoringIncident
  | contains("_fetchMerklSingleRates()")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt
  | contains("_fetchMerklSingleRates()")
' "$CONFIG" >/dev/null

jq -e '
  .sre.promptTemplates.monitoringIncident
  | contains("merged reward row")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt
  | contains("merged reward row")
' "$CONFIG" >/dev/null

jq -e '
  .sre.promptTemplates.monitoringIncident
  | contains("If current code, query output, or live evidence disproves an earlier theory")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt
  | contains("If current code, query output, or live evidence disproves an earlier theory")
' "$CONFIG" >/dev/null

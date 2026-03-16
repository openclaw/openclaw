#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"

jq -e '
  .channels.slack.requireMention == true and
  .channels.slack.allowImplicitMention == false and
  .channels.slack.streaming == "off" and
  .channels.slack.nativeStreaming == false and
  (.channels.slack.channels["#bug-report"].systemPrompt | contains("ignore replies unless a human explicitly asks to continue RCA") | not) and
  .channels.slack.channels["#bug-report"].requireMention == false and
  .channels.slack.channels["#platform-monitoring"].requireMention == false and
  .channels.slack.channels["#public-api-monitoring"].requireMention == false and
  .channels.slack.channels["#staging-infra-monitoring"].requireMention == false and
  .channels.slack.channels["#bug-report"].allowImplicitMention == false and
  .channels.slack.channels["#platform-monitoring"].allowImplicitMention == false and
  .channels.slack.channels["#public-api-monitoring"].allowImplicitMention == false and
  .channels.slack.channels["#staging-infra-monitoring"].allowImplicitMention == false and
  .channels.slack.channels["#platform-monitoring"].incidentRootOnly == true and
  .channels.slack.channels["#platform-monitoring"].incidentIgnoreResolved == true and
  .channels.slack.channels["#platform-monitoring"].incidentDedupeWindowSeconds == 21600 and
  .channels.slack.channels["#public-api-monitoring"].incidentRootOnly == true and
  .channels.slack.channels["#public-api-monitoring"].incidentIgnoreResolved == true and
  .channels.slack.channels["#public-api-monitoring"].incidentDedupeWindowSeconds == 21600 and
  .channels.slack.channels["#staging-infra-monitoring"].incidentRootOnly == true and
  .channels.slack.channels["#staging-infra-monitoring"].incidentIgnoreResolved == true and
  .channels.slack.channels["#staging-infra-monitoring"].incidentDedupeWindowSeconds == 21600
' "$CONFIG" >/dev/null

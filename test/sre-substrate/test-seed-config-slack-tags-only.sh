#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"

jq -e '
  .channels.slack.requireMention == true and
  .channels.slack.allowImplicitMention == false and
  .channels.slack.channels["#bug-report"].requireMention == false and
  .channels.slack.channels["#platform-monitoring"].requireMention == false and
  .channels.slack.channels["#public-api-monitoring"].requireMention == false and
  .channels.slack.channels["#bug-report"].allowImplicitMention == false and
  .channels.slack.channels["#platform-monitoring"].allowImplicitMention == false and
  .channels.slack.channels["#public-api-monitoring"].allowImplicitMention == false and
  .channels.slack.channels["#platform-monitoring"].incidentRootOnly == true and
  .channels.slack.channels["#platform-monitoring"].incidentIgnoreResolved == true and
  .channels.slack.channels["#platform-monitoring"].incidentDedupeWindowSeconds == 21600 and
  .channels.slack.channels["#public-api-monitoring"].incidentRootOnly == true and
  .channels.slack.channels["#public-api-monitoring"].incidentIgnoreResolved == true and
  .channels.slack.channels["#public-api-monitoring"].incidentDedupeWindowSeconds == 21600 and
  .channels.slack.channels["#staging-infra-monitoring"] == null
' "$CONFIG" >/dev/null

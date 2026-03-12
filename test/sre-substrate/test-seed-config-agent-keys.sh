#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"

jq -e '
  any(.agents.list[]; has("systemPrompt")) | not
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.signingSecret == "${SLACK_SIGNING_SECRET}"
' "$CONFIG" >/dev/null

jq -e '
  .gateway.auth.token == "${OPENCLAW_GATEWAY_TOKEN}"
' "$CONFIG" >/dev/null

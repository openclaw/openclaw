#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"

jq -e '
  .plugins.entries.acpx.config.mcpServers["posthog-prd-landing"].command == "/home/node/.openclaw/skills/morpho-sre/scripts/posthog-mcp.sh"
' "$CONFIG" >/dev/null

jq -e '
  .plugins.entries.acpx.config.mcpServers["posthog-prd-landing"].args == ["prd","--project-key","landing"]
' "$CONFIG" >/dev/null

jq -e '
  .plugins.entries.acpx.config.mcpServers["posthog-dev-vmv1"].args == ["dev","--project-key","vmv1"]
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("/home/node/.openclaw/skills/morpho-sre/scripts/consumer-bug-preflight.sh")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("Never claim no Sentry, PostHog, Linear, or Foundry access")
' "$CONFIG" >/dev/null

test -f "$ROOT/posthog-mcp.sh"
test -f "$ROOT/frontend-project-resolver.sh"
test -f "$ROOT/sentry-cli.sh"
test -f "$ROOT/sentry-api.sh"
test -f "$ROOT/consumer-bug-preflight.sh"
test -f "$ROOT/wiz-mcp.sh"

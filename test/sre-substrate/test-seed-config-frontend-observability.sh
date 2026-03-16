#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"
START_GATEWAY="$REPO_ROOT/scripts/sre-runtime/start-gateway.sh"

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

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("Never send progress-only replies")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("single non-incident acknowledgment containing a concrete ETA and expected next step")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("Before claiming repo/tool access is unavailable, run one live probe")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("Before accepting any task that requires repo access")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("If a human challenges or contradicts a technical claim in any thread")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#platform-monitoring"].systemPrompt == "Template: sre.promptTemplates.monitoringIncident"
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#staging-infra-monitoring"].systemPrompt == "Template: sre.promptTemplates.monitoringIncident"
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#public-api-monitoring"].systemPrompt == "Template: sre.promptTemplates.monitoringIncident"
' "$CONFIG" >/dev/null

jq -e '
  .agents.list[] | select(.id=="sre").tools.exec.pathPrepend | not
' "$CONFIG" >/dev/null

jq -e '
  .agents.list[] | select(.id=="sre-verifier").tools.exec.pathPrepend | not
' "$CONFIG" >/dev/null

jq -e '
  .tools.exec.pathPrepend | not
' "$CONFIG" >/dev/null

rg -Fq 'wrapper_dir="${OPENCLAW_WRAPPER_BIN_DIR:-/home/node/.openclaw/bin}"' "$START_GATEWAY"
rg -Fq -- '--arg wrapper_bin_dir "${OPENCLAW_WRAPPER_BIN_DIR:-/home/node/.openclaw/bin}"' "$START_GATEWAY"
rg -q '\.id == "sre" or \.id == "sre-verifier"' "$START_GATEWAY"
rg -q '\.tools\.exec\.pathPrepend = ' "$START_GATEWAY"
rg -Fq 'build_monitoring_incident_prompt() {' "$START_GATEWAY"
rg -Fq 'Never send progress-only replies' "$START_GATEWAY"
rg -Fq 'Before accepting any task that requires repo access' "$START_GATEWAY"
rg -Fq 'If a human challenges or contradicts a technical claim in any thread' "$START_GATEWAY"
rg -q '\.channels\.slack\.channels\["#staging-infra-monitoring"\]\.systemPrompt =' "$START_GATEWAY"
rg -q '\.channels\.slack\.channels\["#public-api-monitoring"\]\.systemPrompt =' "$START_GATEWAY"

test -f "$ROOT/posthog-mcp.sh"
test -f "$ROOT/frontend-project-resolver.sh"
test -f "$ROOT/sentry-cli.sh"
test -f "$ROOT/sentry-api.sh"
test -f "$ROOT/consumer-bug-preflight.sh"
test -f "$ROOT/wiz-mcp.sh"

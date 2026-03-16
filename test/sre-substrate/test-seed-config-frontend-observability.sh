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
  .channels.slack.channels["#platform-monitoring"].systemPrompt == "__START_GATEWAY_MONITORING_PROMPT__"
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#staging-infra-monitoring"].systemPrompt == "__START_GATEWAY_MONITORING_PROMPT__"
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#public-api-monitoring"].systemPrompt == "__START_GATEWAY_MONITORING_PROMPT__"
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
rg -Fq '.id as $agent_id' "$START_GATEWAY"
rg -Fq '["sre", "sre-k8s", "sre-observability", "sre-release", "sre-repo-runtime", "sre-repo-helm", "sre-verifier"]' "$START_GATEWAY"
rg -Fq 'prepend_unique($entry; $existing)' "$START_GATEWAY"
rg -Fq '. "${SCRIPT_DIR}/lib-prompts.sh"' "$START_GATEWAY"
rg -Fq '__START_GATEWAY_MONITORING_PROMPT__' "$REPO_ROOT/scripts/sre-runtime/lib-prompts.sh"
rg -q '\.channels\.slack\.channels\["#staging-infra-monitoring"\]\.systemPrompt =' "$START_GATEWAY"
rg -q '\.channels\.slack\.channels\["#public-api-monitoring"\]\.systemPrompt =' "$START_GATEWAY"
test -f "$REPO_ROOT/scripts/sre-runtime/lib-prompts.sh"

TMP_CONFIG="$(mktemp)"
trap 'rm -f "$TMP_CONFIG"' EXIT
jq --arg wrapper_bin_dir "/tmp/openclaw-bin" '
  def prepend_unique($entry; $existing):
    reduce ([$entry] + $existing)[] as $item
      ([];
        if ($item | type) != "string" or ($item | length) == 0 or index($item) != null then
          .
        else
          . + [$item]
        end
      );
  .agents.list = (
    (.agents.list // [])
    | map(
        .id as $agent_id
        | if (["sre", "sre-k8s", "sre-observability", "sre-release", "sre-repo-runtime", "sre-repo-helm", "sre-verifier"] | index($agent_id)) != null then
            .tools = (.tools // {})
            | .tools.exec = (
                if ((.tools.exec // null) | type) == "object" then
                  .tools.exec
                else
                  {}
                end
              )
            | .tools.exec.pathPrepend = prepend_unique(
                $wrapper_bin_dir;
                (
                  (.tools.exec.pathPrepend // [])
                  | if type == "array" then . else [] end
                )
              )
          else
            .
          end
      )
  )
' "$CONFIG" >"$TMP_CONFIG"

jq -e '.agents.list[] | select(.id=="sre").tools.exec.pathPrepend[0] == "/tmp/openclaw-bin"' "$TMP_CONFIG" >/dev/null
jq -e '.agents.list[] | select(.id=="sre-verifier").tools.exec.pathPrepend[0] == "/tmp/openclaw-bin"' "$TMP_CONFIG" >/dev/null
jq -e '.agents.list[] | select(.id=="sre-k8s").tools.exec.pathPrepend[0] == "/tmp/openclaw-bin"' "$TMP_CONFIG" >/dev/null
jq -e '.agents.list[] | select(.id=="main") | (.tools.exec.pathPrepend | not)' "$TMP_CONFIG" >/dev/null

test -f "$ROOT/posthog-mcp.sh"
test -f "$ROOT/frontend-project-resolver.sh"
test -f "$ROOT/sentry-cli.sh"
test -f "$ROOT/sentry-api.sh"
test -f "$ROOT/consumer-bug-preflight.sh"
test -f "$ROOT/wiz-mcp.sh"

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
  .channels.slack.channels["#bug-report"].systemPrompt | contains("__PROGRESS_ONLY_REPLY_ANY_SLACK_RULE__")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#sdks"].systemPrompt | contains("__PROGRESS_ONLY_REPLY_RULE__")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("Before claiming repo/tool access is unavailable, run one live probe")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("Before accepting any task that requires repo access")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("use the ticket `branchName` as the PR branch")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("prefer direct tool commands; use `bash -lc` only when the command really needs shell features")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("only fall back to `python` after a live `command -v python` check")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("If a human challenges or contradicts a technical claim in any thread")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("replay the exact artifact and prove state/history chronology before code blame")
' "$CONFIG" >/dev/null

jq -e '
  .channels.slack.channels["#bug-report"].systemPrompt | contains("Do not name a UI-label/rendering cause or suggest a fix PR until you have exact artifact replay")
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
rg -Fq '__PROGRESS_ONLY_REPLY_RULE__' "$REPO_ROOT/scripts/sre-runtime/lib-prompts.sh"
rg -Fq '__PROGRESS_ONLY_REPLY_ANY_SLACK_RULE__' "$REPO_ROOT/scripts/sre-runtime/lib-prompts.sh"
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

# Integration test: monitoring prompt resolution via jq pipeline
PROMPT_LIB="$REPO_ROOT/scripts/sre-runtime/lib-prompts.sh"
# shellcheck source=../../scripts/sre-runtime/lib-prompts.sh
. "$PROMPT_LIB"
TEST_PROMPT="$(OPENCLAW_SRE_SKILL_DIR="/test/skills" build_monitoring_incident_prompt)"
TEST_MARKER="$(monitoring_incident_prompt_marker)"
TEST_PROGRESS_ONLY_RULE="$(build_progress_only_reply_rule)"
TEST_PROGRESS_ONLY_RULE_MARKER="$(progress_only_reply_rule_marker)"
TEST_PROGRESS_ONLY_ANY_SLACK_RULE="$(build_progress_only_reply_rule ' in any Slack context.')"
TEST_PROGRESS_ONLY_ANY_SLACK_RULE_MARKER="$(progress_only_reply_any_slack_rule_marker)"

TMP_PROMPT_CONFIG="$(mktemp)"
trap 'rm -f "$TMP_CONFIG" "$TMP_PROMPT_CONFIG"' EXIT

jq --arg monitoring_prompt "$TEST_PROMPT" \
   --arg monitoring_prompt_marker "$TEST_MARKER" \
   --arg progress_only_reply_rule "$TEST_PROGRESS_ONLY_RULE" \
   --arg progress_only_reply_rule_marker "$TEST_PROGRESS_ONLY_RULE_MARKER" \
   --arg progress_only_reply_any_slack_rule "$TEST_PROGRESS_ONLY_ANY_SLACK_RULE" \
   --arg progress_only_reply_any_slack_rule_marker "$TEST_PROGRESS_ONLY_ANY_SLACK_RULE_MARKER" '
  def replace_prompt_markers:
    if type != "string" then
      .
    else
      gsub($progress_only_reply_rule_marker; $progress_only_reply_rule)
      | gsub($progress_only_reply_any_slack_rule_marker; $progress_only_reply_any_slack_rule)
    end;
  .channels.slack.channels |= with_entries(
    if ((.value.systemPrompt // null) | type) == "string" then
      .value.systemPrompt |= replace_prompt_markers
    else
      .
    end
  )
  | 
  if .channels.slack.channels["#platform-monitoring"] != null then
    .channels.slack.channels["#platform-monitoring"].systemPrompt =
      (if (.channels.slack.channels["#platform-monitoring"].systemPrompt == $monitoring_prompt_marker) or (.channels.slack.channels["#platform-monitoring"].systemPrompt == null) then
        $monitoring_prompt
      else
        .channels.slack.channels["#platform-monitoring"].systemPrompt
      end)
  else . end
  | if .channels.slack.channels["#staging-infra-monitoring"] != null then
      .channels.slack.channels["#staging-infra-monitoring"].systemPrompt =
        ($monitoring_prompt | sub("^Monitoring incident intake mode:"; "Staging monitoring incident intake mode:"))
    else . end
  | if .channels.slack.channels["#public-api-monitoring"] != null then
      .channels.slack.channels["#public-api-monitoring"].systemPrompt =
        ($monitoring_prompt | sub("^Monitoring incident intake mode:"; "Public API monitoring incident intake mode:"))
    else . end
' "$CONFIG" >"$TMP_PROMPT_CONFIG"

# Verify marker was resolved to real prompt
jq -e '.channels.slack.channels["#platform-monitoring"].systemPrompt | startswith("Monitoring incident intake mode:")' "$TMP_PROMPT_CONFIG" >/dev/null
# Verify staging gets prefixed prompt
jq -e '.channels.slack.channels["#staging-infra-monitoring"].systemPrompt | startswith("Staging monitoring incident intake mode:")' "$TMP_PROMPT_CONFIG" >/dev/null
# Verify public-api gets prefixed prompt
jq -e '.channels.slack.channels["#public-api-monitoring"].systemPrompt | startswith("Public API monitoring incident intake mode:")' "$TMP_PROMPT_CONFIG" >/dev/null
# Verify non-monitoring channel was NOT affected
jq -e '.channels.slack.channels["#bug-report"].systemPrompt | startswith("Monitoring") | not' "$TMP_PROMPT_CONFIG" >/dev/null
jq -e '.channels.slack.channels["#bug-report"].systemPrompt | contains("Never send progress-only replies")' "$TMP_PROMPT_CONFIG" >/dev/null
jq -e '.channels.slack.channels["#bug-report"].systemPrompt | contains("in any Slack context. Wait for the final reply.")' "$TMP_PROMPT_CONFIG" >/dev/null
jq -e '.channels.slack.channels["#sdks"].systemPrompt | contains("Never send progress-only replies")' "$TMP_PROMPT_CONFIG" >/dev/null
jq -e '.channels.slack.channels["#sdks"].systemPrompt | contains("Wait for the final reply.")' "$TMP_PROMPT_CONFIG" >/dev/null
jq -e '.channels.slack.channels["#sdks"].systemPrompt | contains("__PROGRESS_ONLY_REPLY_RULE__") | not' "$TMP_PROMPT_CONFIG" >/dev/null

jq -r '.channels.slack.channels["#platform-monitoring"].systemPrompt' "$TMP_PROMPT_CONFIG" | rg -F 'use the ticket `branchName` as the PR branch' >/dev/null
jq -r '.channels.slack.channels["#platform-monitoring"].systemPrompt' "$TMP_PROMPT_CONFIG" | rg -F 'prefer direct tool commands; use `bash -lc` only when the command really needs shell features' >/dev/null
jq -r '.channels.slack.channels["#platform-monitoring"].systemPrompt' "$TMP_PROMPT_CONFIG" | rg -F 'only fall back to `python` after a live `command -v python` check' >/dev/null

test -f "$ROOT/posthog-mcp.sh"
test -f "$ROOT/frontend-project-resolver.sh"
test -f "$ROOT/sentry-cli.sh"
test -f "$ROOT/sentry-api.sh"
test -f "$ROOT/consumer-bug-preflight.sh"
test -f "$ROOT/wiz-api.sh"

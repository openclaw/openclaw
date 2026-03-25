#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

RUNTIME_REPO="$TMP_ROOT/runtime/openclaw-sre"
STATE_DIR="$TMP_ROOT/state"
SKILL_ROOT="$RUNTIME_REPO/skills/morpho-sre"

mkdir -p "$SKILL_ROOT/config" "$SKILL_ROOT/references" "$SKILL_ROOT/evidence-manifests"
for bundled_skill in \
  argocd-diff \
  eks-troubleshoot \
  foundry-evm-debug \
  grafana-metrics-best-practices \
  go-memory-profiling \
  terraform-ci-review \
  vercel \
  sre-incident-triage \
  sre-db-evidence \
  sre-api-wrappers \
  sre-auto-remediation \
  sre-consumer-frontend \
  sre-sentinel \
  sre-verify; do
  mkdir -p "$RUNTIME_REPO/skills/$bundled_skill"
  cp -R "$REPO_ROOT/skills/$bundled_skill/." "$RUNTIME_REPO/skills/$bundled_skill/"
done

cp "$REPO_ROOT/skills/morpho-sre/SKILL.md" "$SKILL_ROOT/SKILL.md"
cp "$REPO_ROOT/skills/morpho-sre/HEARTBEAT.md" "$SKILL_ROOT/HEARTBEAT.md"
cp "$REPO_ROOT/skills/morpho-sre/config/openclaw.json" "$SKILL_ROOT/config/openclaw.json"
cp "$REPO_ROOT/skills/morpho-sre/sentinel-triage.sh" "$SKILL_ROOT/sentinel-triage.sh"
cp "$REPO_ROOT/skills/morpho-sre/repo-ownership.json" "$SKILL_ROOT/repo-ownership.json"
cp "$REPO_ROOT/skills/morpho-sre/knowledge-index.md" "$SKILL_ROOT/knowledge-index.md"
cp -R "$REPO_ROOT/skills/morpho-sre/references/." "$SKILL_ROOT/references/"
cp -R "$REPO_ROOT/skills/morpho-sre/evidence-manifests/." "$SKILL_ROOT/evidence-manifests/"

OPENCLAW_SRE_RUNTIME_REPO_DIR="$RUNTIME_REPO" \
OPENCLAW_STATE_DIR="$STATE_DIR" \
OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json" \
OPENCLAW_SRE_SLACK_INCIDENT_CHANNELS="Ops-War-Room,#bug-report,Api-War-Room" \
bash "$REPO_ROOT/scripts/sre-runtime/seed-state.sh" >/dev/null

jq -e '
  (.channels.slack.channels | keys) == ["#api-war-room", "#bug-report", "#ops-war-room"] and
  .channels.slack.channels["#bug-report"].requireMention == false and
  .channels.slack.channels["#ops-war-room"].requireMention == false and
  .channels.slack.channels["#ops-war-room"].incidentRootOnly == true and
  .channels.slack.channels["#ops-war-room"].incidentIgnoreResolved == true and
  .channels.slack.channels["#ops-war-room"].allowImplicitMention == false and
  .channels.slack.channels["#ops-war-room"].systemPrompt == .channels.slack.channels["#api-war-room"].systemPrompt and
  (.channels.slack.channels["#ops-war-room"].systemPrompt | contains("_fetchMerklSingleRates()")) and
  (.channels.slack.channels["#ops-war-room"].systemPrompt | contains("merged reward row")) and
  .channels.slack.channels["#platform-monitoring"] == null
' "$STATE_DIR/openclaw.json" >/dev/null

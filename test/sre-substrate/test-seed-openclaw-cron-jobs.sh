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
bash "$REPO_ROOT/scripts/sre-runtime/seed-state.sh" >/dev/null

jq -e '
  .version == 1 and
  (.jobs | length) == 2 and
  all(.jobs[];
    .agentId == "sre" and
    .enabled == true and
    .schedule.kind == "cron" and
    .schedule.expr == "0 */12 * * *" and
    .schedule.tz == "UTC" and
    .sessionTarget == "isolated" and
    .wakeMode == "now" and
    .payload.kind == "agentTurn" and
    .payload.lightContext == true and
    .delivery.mode == "announce" and
    .delivery.channel == "slack"
  ) and
  any(.jobs[]; .id == "sre-12h-platform-monitoring" and .delivery.to == "channel:#platform-monitoring") and
  any(.jobs[]; .id == "sre-12h-staging-infra-monitoring" and .delivery.to == "channel:#staging-infra-monitoring")
' "$STATE_DIR/cron/jobs.json" >/dev/null

platform_created_at="$(jq -r '.jobs[] | select(.id == "sre-12h-platform-monitoring").createdAtMs' "$STATE_DIR/cron/jobs.json")"
staging_created_at="$(jq -r '.jobs[] | select(.id == "sre-12h-staging-infra-monitoring").createdAtMs' "$STATE_DIR/cron/jobs.json")"

tmp_jobs="$(mktemp)"
trap 'rm -f "$tmp_jobs"; rm -rf "$TMP_ROOT"' EXIT
jq '
  .jobs |= map(
    if .id == "sre-12h-platform-monitoring" then
      .state = {"status":"paused"} | .createdAtMs = 111
    elif .id == "sre-12h-staging-infra-monitoring" then
      .state = {"status":"running"} | .createdAtMs = 222
    else
      .
    end
  )
' "$STATE_DIR/cron/jobs.json" >"$tmp_jobs"
mv "$tmp_jobs" "$STATE_DIR/cron/jobs.json"

OPENCLAW_SRE_RUNTIME_REPO_DIR="$RUNTIME_REPO" \
OPENCLAW_STATE_DIR="$STATE_DIR" \
OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json" \
bash "$REPO_ROOT/scripts/sre-runtime/seed-state.sh" >/dev/null

jq -e '
  (.jobs | length) == 2 and
  any(.jobs[]; .id == "sre-12h-platform-monitoring" and .createdAtMs == 111 and .state.status == "paused" and .wakeMode == "now") and
  any(.jobs[]; .id == "sre-12h-staging-infra-monitoring" and .createdAtMs == 222 and .state.status == "running" and .wakeMode == "now")
' "$STATE_DIR/cron/jobs.json" >/dev/null

test "$platform_created_at" != "111"
test "$staging_created_at" != "222"

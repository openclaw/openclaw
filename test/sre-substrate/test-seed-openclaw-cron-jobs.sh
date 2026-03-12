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
  terraform-ci-review; do
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
    .wakeMode == "next-heartbeat" and
    .payload.kind == "agentTurn" and
    .payload.lightContext == true and
    .delivery.mode == "announce" and
    .delivery.channel == "slack"
  ) and
  any(.jobs[]; .id == "sre-12h-platform-monitoring" and .delivery.to == "channel:#platform-monitoring") and
  any(.jobs[]; .id == "sre-12h-staging-monitoring" and .delivery.to == "channel:#staging-infra-monitoring")
' "$STATE_DIR/cron/jobs.json" >/dev/null

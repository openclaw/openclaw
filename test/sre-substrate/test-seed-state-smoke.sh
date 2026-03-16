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
cp "$REPO_ROOT/skills/morpho-sre/bug-report-routing.json" "$SKILL_ROOT/bug-report-routing.json"
cp "$REPO_ROOT/skills/morpho-sre/bug-report-triage.sh" "$SKILL_ROOT/bug-report-triage.sh"
cp "$REPO_ROOT/skills/morpho-sre/sentinel-triage.sh" "$SKILL_ROOT/sentinel-triage.sh"
cp "$REPO_ROOT/skills/morpho-sre/repo-ownership.json" "$SKILL_ROOT/repo-ownership.json"
cp "$REPO_ROOT/skills/morpho-sre/knowledge-index.md" "$SKILL_ROOT/knowledge-index.md"
cp \
  "$REPO_ROOT/skills/morpho-sre/incident-dossier-blue-api-hyperevm-vault-v2-state-gap-2026-03-12.md" \
  "$SKILL_ROOT/incident-dossier-blue-api-hyperevm-vault-v2-state-gap-2026-03-12.md"
cp -R "$REPO_ROOT/skills/morpho-sre/references/." "$SKILL_ROOT/references/"
cp -R "$REPO_ROOT/skills/morpho-sre/evidence-manifests/." "$SKILL_ROOT/evidence-manifests/"

OPENCLAW_SRE_RUNTIME_REPO_DIR="$RUNTIME_REPO" \
OPENCLAW_STATE_DIR="$STATE_DIR" \
OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json" \
bash "$REPO_ROOT/scripts/sre-runtime/seed-state.sh" >/dev/null

test -f "$STATE_DIR/openclaw.json"
test -f "$STATE_DIR/skills/morpho-sre/SKILL.md"
test -f "$STATE_DIR/skills/morpho-sre/bug-report-routing.json"
test -x "$STATE_DIR/skills/morpho-sre/scripts/bug-report-triage.sh"
test -f "$STATE_DIR/skills/morpho-sre/scripts/sentinel-triage.sh"
test -f "$STATE_DIR/skills/morpho-sre/knowledge-index.md"
test -f "$STATE_DIR/skills/morpho-sre/incident-dossier-blue-api-hyperevm-vault-v2-state-gap-2026-03-12.md"
test -f "$STATE_DIR/state/sre-index/repo-ownership.json"
test -f "$STATE_DIR/workspace/MEMORY.md"
test -f "$STATE_DIR/workspace-sre/MEMORY.md"
test -f "$STATE_DIR/workspace/HEARTBEAT.md"
test -f "$STATE_DIR/workspace-sre/HEARTBEAT.md"
test -f "$STATE_DIR/cron/jobs.json"
test -d "$STATE_DIR/workspace/memory"
test -d "$STATE_DIR/workspace-sre/memory"
ls "$STATE_DIR"/workspace/memory/*.md >/dev/null 2>&1
ls "$STATE_DIR"/workspace-sre/memory/*.md >/dev/null 2>&1
jq -e '
  (.jobs | map(.id) | sort) == ([
    "sre-12h-platform-monitoring",
    "sre-12h-staging-monitoring"
  ] | sort)
' "$STATE_DIR/cron/jobs.json" >/dev/null
test -d "$STATE_DIR/skills/foundry-evm-debug"
test -f "$STATE_DIR/skills/argocd-diff/SKILL.md"
test -f "$STATE_DIR/skills/eks-troubleshoot/SKILL.md"
test -f "$STATE_DIR/skills/grafana-metrics-best-practices/SKILL.md"
test -f "$STATE_DIR/skills/go-memory-profiling/SKILL.md"
test -f "$STATE_DIR/skills/terraform-ci-review/SKILL.md"

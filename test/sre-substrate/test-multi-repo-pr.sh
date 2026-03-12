#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
SCRIPT="$ROOT/multi-repo-pr.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/runtime" "$TMP/helm" "$TMP/bin"
export OPENCLAW_SRE_PLANS_DIR="$TMP/plans"

cat >"$TMP/bin/autofix.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
repo=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    *) shift ;;
  esac
done
number="11"
[[ "$repo" == "morpho-org/morpho-infra-helm" ]] && number="12"
printf 'created https://github.com/%s/pull/%s\n' "$repo" "$number"
EOF
chmod +x "$TMP/bin/autofix.sh"

cat >"$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$GH_LOG"
cat >/dev/null
EOF
chmod +x "$TMP/bin/gh"

cat >"$TMP/ownership.json" <<'EOF'
{"version":"sre.repo-ownership-map.v1","generatedAt":"2026-03-08T00:00:00.000Z","repos":[{"repoId":"openclaw-sre","githubRepo":"morpho-org/openclaw-sre","localPath":"TMP_RUNTIME","ownedGlobs":["src/**"],"sourceOfTruthDomains":["runtime"],"dependentRepos":["morpho-infra-helm"],"ciChecks":["pnpm build"],"validationCommands":["printf runtime-ok"],"rollbackHints":["revert runtime"]},{"repoId":"morpho-infra-helm","githubRepo":"morpho-org/morpho-infra-helm","localPath":"TMP_HELM","ownedGlobs":["charts/openclaw-sre/**"],"sourceOfTruthDomains":["helm"],"dependentRepos":["openclaw-sre"],"ciChecks":["helm template charts/openclaw-sre"],"validationCommands":["printf helm-ok"],"rollbackHints":["revert helm"]}]}
EOF
sed -i '' "s#TMP_RUNTIME#$TMP/runtime#g; s#TMP_HELM#$TMP/helm#g" "$TMP/ownership.json" 2>/dev/null || sed -i "s#TMP_RUNTIME#$TMP/runtime#g; s#TMP_HELM#$TMP/helm#g" "$TMP/ownership.json"

cat >"$TMP/plan.json" <<'EOF'
{
  "version": "sre.change-plan.v1",
  "incident_id": "incident:123",
  "root_cause_summary": "bad rollout",
  "repos": [
    {
      "repo_id": "openclaw-sre",
      "rationale": "runtime fix",
      "files": ["src/x.ts"],
      "base_sha": "abc1234",
      "change_type": "runtime-only",
      "validation_profile": "runtime-only",
      "impacted_apps": ["openclaw-sre"],
      "pr": { "title": "runtime fix", "commit": "fix(runtime): x" }
    },
    {
      "repo_id": "morpho-infra-helm",
      "rationale": "helm follow-up",
      "files": ["charts/openclaw-sre/values.yaml"],
      "depends_on_repos": ["openclaw-sre"],
      "pr": { "title": "helm fix", "commit": "fix(helm): y" }
    }
  ]
}
EOF

PATH="$TMP/bin:$PATH" GH_LOG="$TMP/gh.log" VALIDATE_CHANGE_PLAN_SKIP_ROLLOUT=1 bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" --autofix-script "$TMP/bin/autofix.sh" --dry-run | jq -e '.status=="ok"' >/dev/null

PATH="$TMP/bin:$PATH" GH_LOG="$TMP/gh.log" VALIDATE_CHANGE_PLAN_SKIP_ROLLOUT=1 bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" --autofix-script "$TMP/bin/autofix.sh" --dry-run >"$TMP/dry-run.json"
jq -e '.repos[0].base_sha=="abc1234"' "$TMP/dry-run.json" >/dev/null
jq -e '.repos[0].change_type=="runtime-only"' "$TMP/dry-run.json" >/dev/null
jq -e '.repos[0].validation_profile=="runtime-only"' "$TMP/dry-run.json" >/dev/null
jq -e '.repos[0].impacted_apps==["openclaw-sre"]' "$TMP/dry-run.json" >/dev/null

OUT="$TMP/multi-repo-pr.out"
PATH="$TMP/bin:$PATH" GH_LOG="$TMP/gh.log" VALIDATE_CHANGE_PLAN_SKIP_ROLLOUT=1 bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" --autofix-script "$TMP/bin/autofix.sh" >"$OUT"

jq -e '.repos[0].repo_id=="openclaw-sre"' "$OUT" >/dev/null
jq -e '.repos[1].repo_id=="morpho-infra-helm"' "$OUT" >/dev/null
jq -e '.repos[0].base_sha=="abc1234"' "$OUT" >/dev/null
jq -e '.repos[0].validation_profile=="runtime-only"' "$OUT" >/dev/null
jq -e '.phase=="completed"' "$TMP/plans/plan.state.json" >/dev/null
jq -e '.status=="ok"' "$TMP/plans/plan.state.json" >/dev/null
rg 'pr comment' "$TMP/gh.log" >/dev/null

cat >"$TMP/bin/argocd-unhealthy.sh" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
app_name	sync_status	health_status	last_sync_time	last_sync_result	drift_summary
openclaw-sre	OutOfSync	Degraded	2026-03-08T00:00:00Z	Succeeded	drifted_resources=2;severity=critical
OUT
EOF
chmod +x "$TMP/bin/argocd-unhealthy.sh"

WARNING_SUMMARY="$TMP/warning-validation-summary.json"
PATH="$TMP/bin:$PATH" GH_LOG="$TMP/gh.log" \
  VALIDATE_CHANGE_PLAN_ARGOCD_SYNC_STATUS_SCRIPT="$TMP/bin/argocd-unhealthy.sh" \
  bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" \
  --autofix-script "$TMP/bin/autofix.sh" --validation-summary-file "$WARNING_SUMMARY" --dry-run \
  >"$TMP/warning.out"

jq -e '.status=="ok"' "$TMP/warning.out" >/dev/null
jq -e '.status=="ok"' "$WARNING_SUMMARY" >/dev/null
jq -e '[.repos[].rollout.warnings[] | select(.reason=="impacted_app_unhealthy")] | length == 2' "$WARNING_SUMMARY" >/dev/null
jq -e '[.repos[].rollout.errors[]] | length == 0' "$WARNING_SUMMARY" >/dev/null

cat >"$TMP/bin/argocd-empty.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/bin/argocd-empty.sh"

EMPTY_SUMMARY="$TMP/empty-validation-summary.json"
PATH="$TMP/bin:$PATH" GH_LOG="$TMP/gh.log" \
  VALIDATE_CHANGE_PLAN_ARGOCD_SYNC_STATUS_SCRIPT="$TMP/bin/argocd-empty.sh" \
  bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" \
  --autofix-script "$TMP/bin/autofix.sh" --validation-summary-file "$EMPTY_SUMMARY" --dry-run \
  >"$TMP/empty.out"

jq -e '.status=="ok"' "$TMP/empty.out" >/dev/null
jq -e '.status=="ok"' "$EMPTY_SUMMARY" >/dev/null

cat >"$TMP/bin/argocd-rollout-failed.sh" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
app_name	sync_status	health_status	last_sync_time	last_sync_result	drift_summary
openclaw-sre	OutOfSync	Degraded	2026-03-08T00:00:00Z	Failed	drifted_resources=2;severity=critical
OUT
EOF
chmod +x "$TMP/bin/argocd-rollout-failed.sh"

FAILED_SUMMARY="$TMP/failed-validation-summary.json"
if PATH="$TMP/bin:$PATH" GH_LOG="$TMP/gh.log" \
  VALIDATE_CHANGE_PLAN_ARGOCD_SYNC_STATUS_SCRIPT="$TMP/bin/argocd-rollout-failed.sh" \
  bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" \
  --autofix-script "$TMP/bin/autofix.sh" --validation-summary-file "$FAILED_SUMMARY" --dry-run \
  >"$TMP/failed.out" 2>"$TMP/failed.err"; then
  printf 'expected failed rollout gate to block multi-repo-pr\n' >&2
  exit 1
fi

rg 'change plan validation failed' "$TMP/failed.err" >/dev/null
jq -e '.status=="error"' "$FAILED_SUMMARY" >/dev/null
jq -e '[.repos[].rollout.errors[] | select(.reason=="impacted_app_rollout_failed")] | length == 2' "$FAILED_SUMMARY" >/dev/null

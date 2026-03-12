#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CHECK="$ROOT/change-plan-check.sh"
SCRIPT="$ROOT/validate-change-plan.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/runtime" "$TMP/helm"

cat >"$TMP/ownership.json" <<'EOF'
{"version":"sre.repo-ownership-map.v1","generatedAt":"2026-03-08T00:00:00.000Z","repos":[{"repoId":"openclaw-sre","githubRepo":"morpho-org/openclaw-sre","localPath":"TMP_RUNTIME","ownedGlobs":["src/**"],"sourceOfTruthDomains":["runtime"],"dependentRepos":["morpho-infra-helm"],"ciChecks":["pnpm build"],"validationCommands":["printf runtime-ok"],"validationProfiles":{"runtime-only":["printf runtime-profile-ok"]},"rollbackHints":["revert runtime"]},{"repoId":"morpho-infra-helm","githubRepo":"morpho-org/morpho-infra-helm","localPath":"TMP_HELM","ownedGlobs":["charts/openclaw-sre/**"],"sourceOfTruthDomains":["helm"],"dependentRepos":["openclaw-sre"],"ciChecks":["helm template charts/openclaw-sre"],"validationCommands":["printf helm-ok"],"rollbackHints":["revert helm"]}]}
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

bash "$CHECK" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" >/dev/null
SUMMARY="$TMP/summary.json"
VALIDATE_CHANGE_PLAN_SKIP_ROLLOUT=1 bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" --summary-file "$SUMMARY" >/dev/null

jq -e '.status=="ok"' "$SUMMARY" >/dev/null
jq -e '.repos[0].repo_id=="openclaw-sre"' "$SUMMARY" >/dev/null
jq -e '.repos[1].repo_id=="morpho-infra-helm"' "$SUMMARY" >/dev/null
jq -e '.repos[0].validations[0].status=="ok"' "$SUMMARY" >/dev/null

cat >"$TMP/steps-plan.json" <<'EOF'
{
  "version": "sre.change-plan.v1",
  "incidentId": "incident:steps",
  "summary": "runtime and helm follow-up",
  "steps": [
    {
      "repoId": "openclaw-sre",
      "summary": "fix(runtime): tighten broker path",
      "files": ["src/x.ts"],
      "impactedApps": ["openclaw-sre"],
      "validationProfile": "runtime-only",
      "pr": { "title": "runtime fix from steps" }
    },
    {
      "repoId": "morpho-infra-helm",
      "summary": "fix(helm): align rollout guardrails",
      "files": ["charts/openclaw-sre/values.yaml"],
      "dependsOn": ["openclaw-sre"],
      "pr": { "title": "helm fix from steps" }
    }
  ]
}
EOF

STEPS_NORMALIZED="$TMP/steps-normalized.json"
bash "$CHECK" --plan "$TMP/steps-plan.json" --ownership-file "$TMP/ownership.json" >"$STEPS_NORMALIZED"
jq -e '.repos[0].repo_id=="openclaw-sre"' "$STEPS_NORMALIZED" >/dev/null
jq -e '.repos[0].pr.commit=="fix(runtime): tighten broker path"' "$STEPS_NORMALIZED" >/dev/null
jq -e '.repos[0].impacted_apps==["openclaw-sre"]' "$STEPS_NORMALIZED" >/dev/null
jq -e '.repos[0].expected_validations==["printf runtime-profile-ok"]' "$STEPS_NORMALIZED" >/dev/null
jq -e '.repos[1].depends_on_repos==["openclaw-sre"]' "$STEPS_NORMALIZED" >/dev/null

cat >"$TMP/injected-plan.json" <<'EOF'
{
  "version": "sre.change-plan.v1",
  "incident_id": "incident:inject",
  "root_cause_summary": "attempted command override",
  "repos": [
    {
      "repo_id": "openclaw-sre",
      "rationale": "runtime fix",
      "files": ["src/x.ts"],
      "expected_validations": ["touch /tmp/pwned"],
      "pr": { "title": "runtime fix", "commit": "fix(runtime): x" }
    }
  ]
}
EOF

if bash "$CHECK" --plan "$TMP/injected-plan.json" --ownership-file "$TMP/ownership.json" >"$TMP/injected.out" 2>"$TMP/injected.err"; then
  printf 'expected injected plan to fail normalization\n' >&2
  exit 1
fi
rg 'validation commands must come from ownership map' "$TMP/injected.err" >/dev/null

cat >"$TMP/override-plan.json" <<'EOF'
{
  "version": "sre.change-plan.v1",
  "incident_id": "incident:override",
  "root_cause_summary": "attempted repo override",
  "repos": [
    {
      "repo_id": "openclaw-sre",
      "repo_slug": "morpho-org/evil-fork",
      "local_path": "/tmp/evil-repo",
      "rationale": "runtime fix",
      "files": ["src/x.ts"],
      "pr": { "title": "runtime fix", "commit": "fix(runtime): x" }
    }
  ]
}
EOF

OVERRIDE_NORMALIZED="$TMP/override-normalized.json"
bash "$CHECK" --plan "$TMP/override-plan.json" --ownership-file "$TMP/ownership.json" >"$OVERRIDE_NORMALIZED"
jq -e '.repos[0].repo_slug=="morpho-org/openclaw-sre"' "$OVERRIDE_NORMALIZED" >/dev/null
jq -e --arg path "$TMP/runtime" '.repos[0].local_path==$path' "$OVERRIDE_NORMALIZED" >/dev/null

cat >"$TMP/argocd-auth-error.sh" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
app_name	sync_status	health_status	last_sync_time	last_sync_result	drift_summary
argocd-api	unknown	unknown	n/a	unknown	auth_http_403
OUT
EOF
chmod +x "$TMP/argocd-auth-error.sh"

AUTH_SUMMARY="$TMP/auth-summary.json"
VALIDATE_CHANGE_PLAN_ARGOCD_SYNC_STATUS_SCRIPT="$TMP/argocd-auth-error.sh" \
  bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" --summary-file "$AUTH_SUMMARY" >/dev/null
jq -e '.status=="error"' "$AUTH_SUMMARY" >/dev/null
jq -e '[.repos[].rollout.errors[] | select(.reason=="argocd_auth_error")] | length == 2' "$AUTH_SUMMARY" >/dev/null

cat >"$TMP/argocd-visibility-error.sh" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
app_name	sync_status	health_status	last_sync_time	last_sync_result	drift_summary
argocd-api	unknown	unknown	n/a	unknown	http_503
OUT
EOF
chmod +x "$TMP/argocd-visibility-error.sh"

VISIBILITY_SUMMARY="$TMP/visibility-summary.json"
VALIDATE_CHANGE_PLAN_ARGOCD_SYNC_STATUS_SCRIPT="$TMP/argocd-visibility-error.sh" \
  bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" --summary-file "$VISIBILITY_SUMMARY" >/dev/null
jq -e '.status=="error"' "$VISIBILITY_SUMMARY" >/dev/null
jq -e '[.repos[].rollout.errors[] | select(.reason=="argocd_visibility_error")] | length == 2' "$VISIBILITY_SUMMARY" >/dev/null

cat >"$TMP/argocd-empty.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/argocd-empty.sh"

EMPTY_SUMMARY="$TMP/empty-summary.json"
VALIDATE_CHANGE_PLAN_ARGOCD_SYNC_STATUS_SCRIPT="$TMP/argocd-empty.sh" \
  bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" --summary-file "$EMPTY_SUMMARY" >/dev/null
jq -e '.status=="ok"' "$EMPTY_SUMMARY" >/dev/null
jq -e '[.repos[].rollout | select(.status=="skipped")] | length == 2' "$EMPTY_SUMMARY" >/dev/null

cat >"$TMP/argocd-unhealthy.sh" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
app_name	sync_status	health_status	last_sync_time	last_sync_result	drift_summary
openclaw-sre	OutOfSync	Degraded	2026-03-08T00:00:00Z	Succeeded	drifted_resources=2;severity=critical
OUT
EOF
chmod +x "$TMP/argocd-unhealthy.sh"

UNHEALTHY_SUMMARY="$TMP/unhealthy-summary.json"
VALIDATE_CHANGE_PLAN_ARGOCD_SYNC_STATUS_SCRIPT="$TMP/argocd-unhealthy.sh" \
  bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" --summary-file "$UNHEALTHY_SUMMARY" >/dev/null
jq -e '.status=="ok"' "$UNHEALTHY_SUMMARY" >/dev/null
jq -e '[.repos[] | select(.status=="ok")] | length == 2' "$UNHEALTHY_SUMMARY" >/dev/null
jq -e '[.repos[].rollout.warnings[] | select(.reason=="impacted_app_unhealthy")] | length == 2' "$UNHEALTHY_SUMMARY" >/dev/null
jq -e '[.repos[].rollout.errors[]] | length == 0' "$UNHEALTHY_SUMMARY" >/dev/null

cat >"$TMP/argocd-rollout-failed.sh" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
app_name	sync_status	health_status	last_sync_time	last_sync_result	drift_summary
openclaw-sre	OutOfSync	Degraded	2026-03-08T00:00:00Z	Failed	drifted_resources=2;severity=critical
OUT
EOF
chmod +x "$TMP/argocd-rollout-failed.sh"

FAILED_ROLLOUT_SUMMARY="$TMP/failed-rollout-summary.json"
VALIDATE_CHANGE_PLAN_ARGOCD_SYNC_STATUS_SCRIPT="$TMP/argocd-rollout-failed.sh" \
  bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" --summary-file "$FAILED_ROLLOUT_SUMMARY" >/dev/null
jq -e '.status=="error"' "$FAILED_ROLLOUT_SUMMARY" >/dev/null
jq -e '[.repos[].rollout.errors[] | select(.reason=="impacted_app_rollout_failed")] | length == 2' "$FAILED_ROLLOUT_SUMMARY" >/dev/null

cat >"$TMP/argocd-stale-failed.sh" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
app_name	sync_status	health_status	last_sync_time	last_sync_result	drift_summary
openclaw-sre	Synced	Healthy	2026-03-08T00:00:00Z	Failed	drifted_resources=0;severity=ok
OUT
EOF
chmod +x "$TMP/argocd-stale-failed.sh"

STALE_FAILED_SUMMARY="$TMP/stale-failed-summary.json"
VALIDATE_CHANGE_PLAN_ARGOCD_SYNC_STATUS_SCRIPT="$TMP/argocd-stale-failed.sh" \
  bash "$SCRIPT" --plan "$TMP/plan.json" --ownership-file "$TMP/ownership.json" --summary-file "$STALE_FAILED_SUMMARY" >/dev/null
jq -e '.status=="ok"' "$STALE_FAILED_SUMMARY" >/dev/null
jq -e '[.repos[].rollout.errors[]] | length == 0' "$STALE_FAILED_SUMMARY" >/dev/null

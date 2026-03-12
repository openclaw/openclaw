#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
SCRIPT="$ROOT/change-intel.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/image-repo-map.sh" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
Filtered matches for image substring: api
namespace	pod	image	image_repo	github_repo	clone_url	local_repo_path	mapping_source	definition_hit
morpho-dev	api-123	registry/api:sha	registry/api	morpho-org/openclaw-sre	https://github.com/morpho-org/openclaw-sre.git	/srv/openclaw/repos/openclaw-sre	commons-ecr-mapping	hit
OUT
EOF
chmod +x "$TMP/image-repo-map.sh"

cat >"$TMP/github-ci-status.sh" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
repo	workflow	run_number	status	conclusion	branch	sha	updated_at	url
morpho-org/openclaw-sre	build	42	completed	failure	main	abc	2026-03-08T00:00:00Z	https://example.invalid/run
OUT
EOF
chmod +x "$TMP/github-ci-status.sh"

cat >"$TMP/argocd-sync-status.sh" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
app_name	sync_status	health_status	last_sync_time	last_sync_result	drift_summary
morpho-org/openclaw-sre	OutOfSync	Degraded	2026-03-08T00:00:00Z	Succeeded	drifted_resources=2;severity=critical
OUT
EOF
chmod +x "$TMP/argocd-sync-status.sh"

out="$(
  CHANGE_INTEL_IMAGE_REPO_MAP_SCRIPT="$TMP/image-repo-map.sh" \
  CHANGE_INTEL_GITHUB_CI_STATUS_SCRIPT="$TMP/github-ci-status.sh" \
  CHANGE_INTEL_ARGOCD_SYNC_STATUS_SCRIPT="$TMP/argocd-sync-status.sh" \
  bash "$SCRIPT" --image api --symptom "error spike"
)"

printf '%s\n' "$out" | jq -e '.version == "sre.change-intel.v1"' >/dev/null
printf '%s\n' "$out" | jq -e '.candidates | length == 1' >/dev/null
printf '%s\n' "$out" | jq -e '.candidates[0].repo == "morpho-org/openclaw-sre"' >/dev/null
printf '%s\n' "$out" | jq -e '.candidates[0].score > 0' >/dev/null
printf '%s\n' "$out" | jq -e '.candidates[0].evidence_row.kind == "change_candidate"' >/dev/null

echo "ok"

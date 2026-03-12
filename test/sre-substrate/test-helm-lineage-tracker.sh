#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
SCRIPT="$ROOT/helm-lineage-tracker.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/rendered.json" <<'EOF'
{"spec":{"replicas":1,"template":{"metadata":{"annotations":{"team":"ops"}},"spec":{"containers":[{"name":"gateway","image":"repo:v1","resources":{"limits":{"cpu":"1"}},"env":[{"name":"A","value":"1"}],"livenessProbe":{"httpGet":{"path":"/health"}}}]}}}}
EOF
cat >"$TMP/live.json" <<'EOF'
{"spec":{"replicas":2,"template":{"metadata":{"annotations":{"team":"ops"}},"spec":{"containers":[{"name":"gateway","image":"repo:v2","resources":{"limits":{"cpu":"2"}},"env":[{"name":"A","value":"1"}],"livenessProbe":{"httpGet":{"path":"/health"}}}]}}}}
EOF

git -C "$TMP" init -q
git -C "$TMP" config user.email test@example.com
git -C "$TMP" config user.name test
mkdir -p "$TMP/charts/openclaw-sre/templates"
printf 'deployment\n' >"$TMP/charts/openclaw-sre/templates/deployment.yaml"
git -C "$TMP" add charts/openclaw-sre/templates/deployment.yaml
git -C "$TMP" commit -qm "test lineage"

OUTPUT="$(bash "$SCRIPT" --rendered-file "$TMP/rendered.json" --live-file "$TMP/live.json" --repo "$TMP" --field image --field replicas)"

printf '%s\n' "$OUTPUT" | jq -e '.version == "sre.helm-lineage.v1"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.reports | length == 2' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.reports[] | select(.field=="image") | .git.commit != ""' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e '.reports[] | select(.field=="replicas") | .matches_live == false' >/dev/null

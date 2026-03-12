#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
SCRIPT="$ROOT/config-drift-detector.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/rendered.json" <<'EOF'
{"spec":{"replicas":1,"template":{"metadata":{"annotations":{"team":"ops"}},"spec":{"containers":[{"name":"gateway","image":"repo:v1","resources":{"limits":{"cpu":"1"}},"env":[{"name":"A","value":"1"}],"livenessProbe":{"httpGet":{"path":"/health"}}}]}}}}
EOF
cat >"$TMP/live.json" <<'EOF'
{"spec":{"replicas":1,"template":{"metadata":{"annotations":{"team":"app"}},"spec":{"containers":[{"name":"gateway","image":"repo:v2","resources":{"limits":{"cpu":"1"}},"env":[{"name":"A","value":"1"}],"livenessProbe":{"httpGet":{"path":"/healthz"}}}]}}}}
EOF

OUTPUT="$(bash "$SCRIPT" --rendered-file "$TMP/rendered.json" --live-file "$TMP/live.json" --scope ns/service)"

LINES="$(printf '%s\n' "$OUTPUT" | awk 'NF > 0 { c++ } END { print c + 0 }')"
[[ "$LINES" -ge 2 ]]
printf '%s\n' "$OUTPUT" | jq -e 'select(.payload.field=="image") | .payload.severity=="critical"' >/dev/null
printf '%s\n' "$OUTPUT" | jq -e 'select(.payload.field=="annotations") | .payload.severity=="warning"' >/dev/null

#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
SCRIPT="$ROOT/sre-state-maintenance.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/state/sre-graph" "$TMP/state/sre-index/shadow-evidence" "$TMP/state/sre-dossiers/incident-a"

cat >"$TMP/state/sre-graph/nodes.ndjson" <<'EOF'
{"entityId":"a","value":1}
{"entityId":"a","value":2}
{"entityId":"b","value":3}
EOF

cat >"$TMP/state/sre-graph/edges.ndjson" <<'EOF'
{"edgeId":"e1","from":"a","to":"b"}
{"edgeId":"e1","from":"a","to":"b","value":2}
EOF

touch -t 202601010000 "$TMP/state/sre-index/shadow-evidence/old.json"
touch "$TMP/state/sre-dossiers/incident-a/keep.json"

out="$(
  OPENCLAW_STATE_DIR="$TMP" \
  OPENCLAW_SRE_GRAPH_DIR="$TMP/state/sre-graph" \
  OPENCLAW_SRE_INDEX_DIR="$TMP/state/sre-index" \
  OPENCLAW_SRE_DOSSIERS_DIR="$TMP/state/sre-dossiers" \
  SRE_SHADOW_RETENTION_DAYS=1 \
  bash "$SCRIPT"
)"

printf '%s\n' "$out" | jq -e '.status == "ok"' >/dev/null
[[ ! -e "$TMP/state/sre-index/shadow-evidence/old.json" ]]
[[ "$(wc -l <"$TMP/state/sre-graph/nodes.ndjson" | tr -d ' ')" == "2" ]]
[[ "$(wc -l <"$TMP/state/sre-graph/edges.ndjson" | tr -d ' ')" == "1" ]]

echo "ok"

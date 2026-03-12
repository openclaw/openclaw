#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../../skills/morpho-sre" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat >"${TMP_DIR}/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *"get pods -A -o json"* ]]; then
  cat <<'JSON'
{"items":[{"metadata":{"namespace":"morpho-dev","name":"api-1"},"status":{"containerStatuses":[{"restartCount":3}]}}]}
JSON
  exit 0
fi
if [[ "$args" == *"get hpa -A -o json"* ]]; then
  cat <<'JSON'
{"items":[{"metadata":{"namespace":"morpho-dev","name":"api-hpa"},"spec":{"minReplicas":2,"maxReplicas":8},"status":{"currentReplicas":2,"desiredReplicas":5}}]}
JSON
  exit 0
fi
if [[ "$args" == *"get deploy,statefulset -A -o json"* ]]; then
  cat <<'JSON'
{"items":[{"kind":"Deployment","metadata":{"namespace":"morpho-dev","name":"api","creationTimestamp":"2026-03-07T10:00:00Z","annotations":{"deployment.kubernetes.io/revision":"3"}},"spec":{"template":{"spec":{"containers":[{"image":"repo/api:abc"}]}}}}]}
JSON
  exit 0
fi
if [[ "$args" == *"get configmap,secret -A -o json"* ]]; then
  cat <<'JSON'
{"items":[{"kind":"ConfigMap","metadata":{"namespace":"morpho-dev","name":"api-config","creationTimestamp":"2026-03-07T10:05:00Z"}}]}
JSON
  exit 0
fi
printf '{"items":[]}\n'
EOF
chmod +x "${TMP_DIR}/kubectl"

output="$(
  PATH="${TMP_DIR}:$PATH" \
  CHANGE_WINDOW_MINUTES=360 \
  SCOPE_NAMESPACES="morpho-dev" \
  ARGOCD_BASE_URL="" \
  bash "${ROOT_DIR}/changes-in-window.sh"
)"

printf '%s\n' "$output" | jq -e '.event_count >= 3' >/dev/null
printf '%s\n' "$output" | jq -e '.timeline_ndjson | length > 0' >/dev/null
printf '%s\n' "$output" | jq -e '.evidence_ndjson | length > 0' >/dev/null
printf '%s\n' "$output" | jq -r '.summary_block' | rg -F 'Recent change window:' >/dev/null

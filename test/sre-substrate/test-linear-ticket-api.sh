#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/skills/morpho-sre/linear-ticket-api.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat >"${TMP}/mock-curl.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

payload=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data)
      payload="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if printf '%s' "$payload" | grep -F 'viewer {' >/dev/null; then
  printf '%s\n' '{"data":{"viewer":{"id":"viewer-1","name":"Test User","email":"test@example.com"}}}'
  exit 0
fi

printf '%s\n' '{"errors":[{"message":"unexpected query"}]}'
exit 0
EOF
chmod +x "${TMP}/mock-curl.sh"

probe_output="$(
  LINEAR_API_KEY='token' LINEAR_CURL_BIN="${TMP}/mock-curl.sh" "${SCRIPT_PATH}" probe-auth # pragma: allowlist secret
)"

printf '%s\n' "$probe_output" | jq -e '.ok == true' >/dev/null
printf '%s\n' "$probe_output" | jq -e '.viewerId == "viewer-1"' >/dev/null
printf '%s\n' "$probe_output" | jq -e '.viewerName == "Test User"' >/dev/null
printf '%s\n' "$probe_output" | jq -e '.viewerEmail == "test@example.com"' >/dev/null

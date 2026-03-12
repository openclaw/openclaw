#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/skills/morpho-sre/wiz-mcp.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

printf 'jwt-token\n' >"${TMP}/jwt"

cat >"${TMP}/mock-curl.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" == *"/v1/auth/kubernetes/login"* ]]; then
  printf '%s\n' '{"auth":{"client_token":"vault-token"}}'
  exit 0
fi

if [[ "$*" == *"/v1/secret/data/wiz/api-token"* ]]; then
  printf '%s\n' '{"data":{"data":{"client_id":"vault-client-id","client_secret":"vault-client-secret","client_endpoint":"ap2"}}}'
  exit 0
fi

printf 'HTTP/1.1 200 OK\r\n'
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      printf '%s' '{"ok":true}' >"$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
EOF
chmod +x "${TMP}/mock-curl.sh"

cat >"${TMP}/mock-curl-fail.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 7
EOF
chmod +x "${TMP}/mock-curl-fail.sh"

plan_env="$(
  export WIZ_MCP_SKIP_VAULT=1
  export WIZ_CLIENT_ID='env-client-id'
  export WIZ_CLIENT_SECRET='env-client-secret' # pragma: allowlist secret
  export WIZ_DATA_CENTER='eu2'
  "${SCRIPT_PATH}" --print-plan
)"

printf '%s\n' "$plan_env" | jq -e '.credentialSource == "env"' >/dev/null
printf '%s\n' "$plan_env" | jq -e '.dataCenter == "eu2"' >/dev/null
printf '%s\n' "$plan_env" | jq -e '.args | index("env-client-secret") | not' >/dev/null
printf '%s\n' "$plan_env" | jq -e '.args | index("Wiz-Client-Secret: ${WIZ_MCP_ACTIVE_CLIENT_SECRET}") != null' >/dev/null

plan_vault="$(
  export VAULT_ADDR='https://config.morpho.dev'
  export VAULT_KUBERNETES_AUTH_PATH='kubernetes'
  export VAULT_KUBERNETES_ROLE='incident-readonly-agent'
  export WIZ_CLIENT_ID='stale-env-id'
  export WIZ_CLIENT_SECRET='stale-env-secret' # pragma: allowlist secret
  export WIZ_MCP_CURL_BIN="${TMP}/mock-curl.sh"
  export WIZ_MCP_JQ_BIN='jq'
  export WIZ_MCP_NPX_BIN='npx'
  export WIZ_MCP_VAULT_JWT_FILE="${TMP}/jwt"
  "${SCRIPT_PATH}" --print-plan
)"

printf '%s\n' "$plan_vault" | jq -e '.credentialSource == "vault:secret/data/wiz/api-token"' >/dev/null
printf '%s\n' "$plan_vault" | jq -e '.dataCenter == "ap2"' >/dev/null
printf '%s\n' "$plan_vault" | jq -e '.args | index("stale-env-secret") | not' >/dev/null

probe_fail="$(
  export WIZ_MCP_SKIP_VAULT=1
  export WIZ_CLIENT_ID='env-client-id'
  export WIZ_CLIENT_SECRET='env-client-secret' # pragma: allowlist secret
  export WIZ_MCP_CURL_BIN="${TMP}/mock-curl-fail.sh"
  "${SCRIPT_PATH}" --probe-auth
)"

printf '%s\n' "$probe_fail" | jq -e '.ok == false' >/dev/null
printf '%s\n' "$probe_fail" | jq -e '.curlExitCode == 7' >/dev/null

if "${SCRIPT_PATH}" --print-plan >/dev/null 2>&1; then
  echo 'expected missing-credentials failure' >&2
  exit 1
fi

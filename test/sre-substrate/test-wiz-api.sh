#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/skills/morpho-sre/wiz-api.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

assert_ok() {
  local desc="$1"
  if eval "$2"; then
    PASS=$((PASS + 1))
    printf '  PASS: %s\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL: %s\n' "$desc" >&2
  fi
}

printf '=== test-wiz-api: credential loading ===\n'

# --- env credentials ---
plan_env="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='test-client-id'
  export WIZ_CLIENT_SECRET='test-client-secret'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-env.json"
  "${SCRIPT_PATH}" --print-plan 2>/dev/null
)"

assert_ok "env: credentialSource is env" \
  "printf '%s' '$plan_env' | jq -e '.credentialSource == \"env\"' >/dev/null"
assert_ok "env: does not leak client_secret" \
  "! printf '%s' '$plan_env' | grep -q 'test-client-secret'"

# --- vault credentials ---
printf '%s\n' 'jwt-token' >"${TMP}/jwt"

cat >"${TMP}/mock-curl-vault.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    */v1/auth/kubernetes/login)
      printf '{"auth":{"client_token":"vault-tok"}}\n'
      exit 0
      ;;
    */v1/secret/data/wiz/api-token)
      printf '{"data":{"data":{"client_id":"vault-cid","client_secret":"vault-csec"}}}\n'
      exit 0
      ;;
  esac
done
# Default: auth token endpoint (will be added later)
printf '{"access_token":"mock-token","expires_in":3600,"token_type":"Bearer"}\n'
CURL_EOF
chmod +x "${TMP}/mock-curl-vault.sh"

plan_vault="$(
  export VAULT_ADDR='https://vault.test'
  export VAULT_KUBERNETES_AUTH_PATH='kubernetes'
  export VAULT_KUBERNETES_ROLE='test-role'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-vault.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_VAULT_JWT_FILE="${TMP}/jwt"
  export WIZ_API_TOKEN_CACHE="${TMP}/token-vault.json"
  export WIZ_CLIENT_ID='stale-env-id'
  export WIZ_CLIENT_SECRET='stale-env-secret'
  "${SCRIPT_PATH}" --print-plan 2>/dev/null
)"

assert_ok "vault: credentialSource is vault" \
  "printf '%s' '$plan_vault' | jq -e '.credentialSource == \"vault:secret/data/wiz/api-token\"' >/dev/null"
assert_ok "vault: does not leak secrets" \
  "! printf '%s' '$plan_vault' | grep -q 'vault-csec'"

# --- missing credentials fail ---
if (
  unset WIZ_CLIENT_ID WIZ_CLIENT_SECRET VAULT_ADDR
  export WIZ_API_SKIP_VAULT=1
  export WIZ_API_TOKEN_CACHE="${TMP}/token-missing.json"
  "${SCRIPT_PATH}" --print-plan >/dev/null 2>&1
); then
  FAIL=$((FAIL + 1))
  printf '  FAIL: missing creds should fail\n' >&2
else
  PASS=$((PASS + 1))
  printf '  PASS: missing creds fail as expected\n'
fi

printf '\n=== test-wiz-api: OAuth2 auth + token caching ===\n'

# --- mock curl that handles both auth and GraphQL ---
cat >"${TMP}/mock-curl-auth.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    */oauth/token)
      printf '{"access_token":"test-bearer-abc","expires_in":3600,"token_type":"Bearer"}\n'
      exit 0
      ;;
  esac
done
# GraphQL endpoint — echo back for inspection
printf '{"data":{"ok":true}}\n'
CURL_EOF
chmod +x "${TMP}/mock-curl-auth.sh"

# --- authenticate and probe ---
probe_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='auth-test-id'
  export WIZ_CLIENT_SECRET='auth-test-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-auth.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-auth.json"
  "${SCRIPT_PATH}" --probe-auth 2>/dev/null
)"

assert_ok "auth: probe returns ok=true" \
  "printf '%s' '$probe_result' | jq -e '.ok == true' >/dev/null"
assert_ok "auth: probe returns credentialSource" \
  "printf '%s' '$probe_result' | jq -e '.credentialSource == \"env\"' >/dev/null"

# --- token cache file created with correct perms ---
assert_ok "auth: token cache file exists" \
  "[[ -f '${TMP}/token-auth.json' ]]"
assert_ok "auth: token cache file has 600 perms" \
  "[[ \"\$(stat -f '%Lp' '${TMP}/token-auth.json' 2>/dev/null || stat -c '%a' '${TMP}/token-auth.json' 2>/dev/null)\" == '600' ]]"

# --- token cache is valid JSON with expires_at ---
assert_ok "auth: token cache has expires_at" \
  "jq -e '.expires_at > 0' '${TMP}/token-auth.json' >/dev/null"

printf '\n=== test-wiz-api: GraphQL execution ===\n'

# --- mock curl that returns GraphQL data ---
cat >"${TMP}/mock-curl-gql.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
http_code_file=""
output_file=""
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    */oauth/token)
      printf '{"access_token":"gql-token","expires_in":3600,"token_type":"Bearer"}\n'
      exit 0
      ;;
    -o)
      i=$((i + 1))
      output_file="${args[$i]}"
      ;;
    -w)
      i=$((i + 1))
      http_code_file="__write_code__"
      ;;
  esac
  i=$((i + 1))
done
# GraphQL response
response='{"data":{"issues":{"nodes":[{"id":"iss-1","severity":"CRITICAL"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}'
if [[ -n "$output_file" ]]; then
  printf '%s' "$response" >"$output_file"
  printf '200'
else
  printf '%s\n' "$response"
fi
CURL_EOF
chmod +x "${TMP}/mock-curl-gql.sh"

query_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='gql-test-id'
  export WIZ_CLIENT_SECRET='gql-test-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-gql.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-gql.json"
  "${SCRIPT_PATH}" query '{ issues(first: 5) { nodes { id severity } pageInfo { hasNextPage endCursor } } }' 2>/dev/null
)"

assert_ok "query: returns data" \
  "printf '%s' '$query_result' | jq -e '.data.issues.nodes[0].id == \"iss-1\"' >/dev/null"

printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1

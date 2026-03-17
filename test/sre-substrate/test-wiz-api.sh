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
output_file=""
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    */oauth/token)
      printf '{"access_token":"test-bearer-abc","expires_in":3600,"token_type":"Bearer"}\n'
      exit 0
      ;;
    -o)
      i=$((i + 1))
      output_file="${args[$i]}"
      ;;
  esac
  i=$((i + 1))
done
# GraphQL endpoint — echo back for inspection
response='{"data":{"ok":true}}'
if [[ -n "$output_file" ]]; then
  printf '%s' "$response" >"$output_file"
  printf '200'
else
  printf '%s\n' "$response"
fi
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

printf '\n=== test-wiz-api: pagination ===\n'

# --- mock curl that returns two pages ---
cat >"${TMP}/mock-curl-paginate.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
output_file=""
data_payload=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -o) output_file="$arg" ;;
    --data) data_payload="$arg" ;;
  esac
  prev="$arg"
done

# Auth endpoint
for arg in "$@"; do
  case "$arg" in
    */oauth/token)
      printf '{"access_token":"pag-token","expires_in":3600}\n'
      exit 0
      ;;
  esac
done

# Check if after cursor is set
if printf '%s' "$data_payload" | jq -e '.variables.after == "cursor-1"' >/dev/null 2>&1; then
  response='{"data":{"issuesV2":{"nodes":[{"id":"iss-2"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}'
else
  response='{"data":{"issuesV2":{"nodes":[{"id":"iss-1"}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor-1"}}}}'
fi

if [[ -n "$output_file" ]]; then
  printf '%s' "$response" >"$output_file"
  printf '200'
else
  printf '%s\n' "$response"
fi
CURL_EOF
chmod +x "${TMP}/mock-curl-paginate.sh"

paginated_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='pag-test-id'
  export WIZ_CLIENT_SECRET='pag-test-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-paginate.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-pag.json"
  "${SCRIPT_PATH}" issues --first 1 2>/dev/null
)"

assert_ok "pagination: merged 2 nodes" \
  "printf '%s' '$paginated_result' | jq -e 'length == 2' >/dev/null"
assert_ok "pagination: first node is iss-1" \
  "printf '%s' '$paginated_result' | jq -e '.[0].id == \"iss-1\"' >/dev/null"
assert_ok "pagination: second node is iss-2" \
  "printf '%s' '$paginated_result' | jq -e '.[1].id == \"iss-2\"' >/dev/null"

printf '\n=== test-wiz-api: subcommands ===\n'

# --- mock curl that echoes back the request payload ---
cat >"${TMP}/mock-curl-echo.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
output_file=""
data_payload=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -o) output_file="$arg" ;;
    --data) data_payload="$arg" ;;
  esac
  prev="$arg"
done
for arg in "$@"; do
  case "$arg" in
    */oauth/token)
      printf '{"access_token":"echo-token","expires_in":3600}\n'
      exit 0
      ;;
  esac
done
# Return mock data matching all subcommand query patterns
response="$(jq -nc '{data:{vulnerabilityFindings:{nodes:[],pageInfo:{hasNextPage:false}},issuesV2:{nodes:[],pageInfo:{hasNextPage:false}},graphSearch:{nodes:[],pageInfo:{hasNextPage:false}},configurationFindings:{nodes:[],pageInfo:{hasNextPage:false}},kubernetesClusters:{nodes:[],pageInfo:{hasNextPage:false}},cloudEvents:{edges:[],pageInfo:{hasNextPage:false}},ic:{totalCount:0},ih:{totalCount:0},im:{totalCount:0},il:{totalCount:0},ii:{totalCount:0},vc:{totalCount:0},vh:{totalCount:0},vm:{totalCount:0},vl:{totalCount:0},cc:{totalCount:0},ch:{totalCount:0},cm:{totalCount:0},cl:{totalCount:0}}}')"
if [[ -n "$output_file" ]]; then
  printf '%s' "$response" >"$output_file"
  printf '200'
else
  printf '%s\n' "$response"
fi
CURL_EOF
chmod +x "${TMP}/mock-curl-echo.sh"

run_subcmd() {
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='sub-test-id'
  export WIZ_CLIENT_SECRET='sub-test-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-echo.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-sub-$1.json"
  "${SCRIPT_PATH}" "$@" 2>/dev/null
}

# Each subcommand should return a JSON array
for subcmd in vulns issues inventory cloud-config k8s runtime; do
  result="$(run_subcmd "$subcmd")"
  assert_ok "${subcmd}: returns JSON array" \
    "printf '%s' '$result' | jq -e 'type == \"array\"' >/dev/null"
done

# Summary returns an object
summary_result="$(run_subcmd summary)"
assert_ok "summary: returns JSON object" \
  "printf '%s' '$summary_result' | jq -e 'type == \"object\"' >/dev/null"
assert_ok "summary: has timestamp" \
  "printf '%s' '$summary_result' | jq -e '.timestamp' >/dev/null"

printf '\n=== test-wiz-api: 401 retry ===\n'

# --- mock curl that returns 401 first, then 200 on retry ---
cat >"${TMP}/mock-curl-401.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
output_file=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -o) output_file="$arg" ;;
  esac
  prev="$arg"
done
for arg in "$@"; do
  case "$arg" in
    */oauth/token)
      printf '{"access_token":"retry-token-%s","expires_in":3600}\n' "$(date +%s%N)"
      exit 0
      ;;
  esac
done
# Track call count via file
count_file="/tmp/wiz-api-401-count"
count=0
if [[ -f "$count_file" ]]; then count="$(cat "$count_file")"; fi
count=$((count + 1))
printf '%s' "$count" >"$count_file"
if [[ "$count" -eq 1 ]]; then
  if [[ -n "$output_file" ]]; then
    printf '{"error":"unauthorized"}' >"$output_file"
    printf '401'
  fi
else
  if [[ -n "$output_file" ]]; then
    printf '{"data":{"test":true}}' >"$output_file"
    printf '200'
  fi
fi
CURL_EOF
chmod +x "${TMP}/mock-curl-401.sh"

rm -f /tmp/wiz-api-401-count
retry_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='retry-id'
  export WIZ_CLIENT_SECRET='retry-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-401.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-retry.json"
  "${SCRIPT_PATH}" query '{ test }' 2>/dev/null
)"
rm -f /tmp/wiz-api-401-count

assert_ok "401 retry: returns data after retry" \
  "printf '%s' '$retry_result' | jq -e '.data.test == true' >/dev/null"

printf '\n=== test-wiz-api: query @file ===\n'

printf '{ fileTest(first: 1) { nodes { id } } }' >"${TMP}/test-query.graphql"
file_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='file-test-id'
  export WIZ_CLIENT_SECRET='file-test-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-auth.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-file.json"
  "${SCRIPT_PATH}" query "@${TMP}/test-query.graphql" 2>/dev/null
)"

assert_ok "query @file: returns data" \
  "printf '%s' '$file_result' | jq -e '.data' >/dev/null"

printf '\n=== test-wiz-api: max-pages limit ===\n'

# Using the pagination mock — with --max-pages 1, should only get 1 node even though hasNextPage=true
maxpages_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='maxpages-id'
  export WIZ_CLIENT_SECRET='maxpages-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-paginate.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-maxpages.json"
  "${SCRIPT_PATH}" issues --first 1 --max-pages 1 2>/dev/null
)"

assert_ok "max-pages: returns only 1 node with --max-pages 1" \
  "printf '%s' '$maxpages_result' | jq -e 'length == 1' >/dev/null"

printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1

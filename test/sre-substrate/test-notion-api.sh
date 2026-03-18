#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/skills/morpho-sre/notion-api.sh"
LIB_PATH="${ROOT_DIR}/skills/morpho-sre/lib-notion-api.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PARTIAL_LIB="${TMP}/lib-notion-api.partial.sh"
# shellcheck disable=SC2016
END_LINE="$(awk '/^print_plan\(\) \{/{print NR; exit}' "$LIB_PATH")"
test -n "$END_LINE"
sed -n "1,$((END_LINE - 1))p" "$LIB_PATH" >"$PARTIAL_LIB"

# shellcheck source=/dev/null
source "$PARTIAL_LIB"

FAKE_CURL="${TMP}/fake-curl.sh"
cat >"$FAKE_CURL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >"${NOTION_TEST_ARGS_LOG:?}"

output_file=""
status_code='200'
response='{"object":"user","id":"user-1","type":"bot","bot":{"workspace_name":"Morpho","workspace_id":"workspace-1"},"properties":{"title":{"title":[]}}}'

args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    -o)
      i=$((i + 1))
      output_file="${args[$i]}"
      ;;
    -w)
      :
      ;;
  esac
  i=$((i + 1))
done

if [[ -n "$output_file" ]]; then
  printf '%s' "$response" >"$output_file"
  printf '%s' "$status_code"
else
  printf '%s\n' "$response"
fi
EOF
chmod +x "$FAKE_CURL"

VAULT_CURL="${TMP}/vault-curl.sh"
cat >"$VAULT_CURL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

payload=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--data" ]]; then
    payload="$arg"
  fi
  case "$arg" in
    */v1/auth/kubernetes/login)
      if [[ -n "${EXPECT_VAULT_ROLE:-}" ]]; then
        actual_role="$(printf '%s\n' "$payload" | jq -r '.role')"
        [[ "$actual_role" == "$EXPECT_VAULT_ROLE" ]] || {
          printf 'unexpected vault role: %s\n' "$actual_role" >&2
          exit 1
        }
      fi
      printf '{"auth":{"client_token":"jwt-vault-token"}}\n'
      exit 0
      ;;
    */v1/secret/data/openclaw-sre/all-secrets)
      printf '{"data":{"data":{"NOTION_SECRET":"vault-token-abcdef"}}}\n'
      exit 0
      ;;
  esac
  prev="$arg"
done

printf '{"object":"user","id":"user-1","type":"bot","bot":{"workspace_name":"Morpho","workspace_id":"workspace-1"}}\n'
EOF
chmod +x "$VAULT_CURL"

plan_secret="$(
  export NOTION_SECRET='secret-token-abcdef'
  export NOTION_SKIP_VAULT=1
  bash "$SCRIPT_PATH" --print-plan 2>/dev/null
)"
printf '%s\n' "$plan_secret" | jq -e '.credentialResolution == "OK"' >/dev/null
printf '%s\n' "$plan_secret" | jq -e '.credentialSource == "env:NOTION_SECRET"' >/dev/null
! printf '%s\n' "$plan_secret" | grep -q 'secret-token-abcdef'

plan_token="$(
  export NOTION_TOKEN='fallback-token-abcdef'
  unset NOTION_SECRET
  export NOTION_SKIP_VAULT=1
  bash "$SCRIPT_PATH" --print-plan 2>/dev/null
)"
printf '%s\n' "$plan_token" | jq -e '.credentialSource == "env:NOTION_TOKEN"' >/dev/null
! printf '%s\n' "$plan_token" | grep -q 'fallback-token-abcdef'

plan_vault_token="$(
  unset NOTION_SECRET NOTION_TOKEN
  export VAULT_ADDR='https://vault.test'
  export VAULT_TOKEN='cached-vault-token'
  export NOTION_CURL_BIN="$VAULT_CURL"
  bash "$SCRIPT_PATH" --print-plan 2>/dev/null
)"
printf '%s\n' "$plan_vault_token" | jq -e '.credentialSource == "vault:secret/data/openclaw-sre/all-secrets (cached token)"' >/dev/null
! printf '%s\n' "$plan_vault_token" | grep -q 'vault-token-abcdef'

detect_service_account_jwt() {
  printf '%s\n' "${TMP}/jwt"
}
printf '%s\n' 'jwt-token' >"${TMP}/jwt"
(
  unset NOTION_SECRET NOTION_TOKEN VAULT_TOKEN
  export VAULT_ADDR='https://vault.test'
  export OPENCLAW_SERVICE_ACCOUNT_NAME='gateway-role-only'
  export EXPECT_VAULT_ROLE='gateway-role-only'
  export NOTION_CURL_BIN="$VAULT_CURL"
  load_secret
  test "$NOTION_CREDENTIAL_SOURCE" = 'vault:secret/data/openclaw-sre/all-secrets (jwt auth)'
  test "$NOTION_ACTIVE_SECRET" = 'vault-token-abcdef'
)

if (
  unset NOTION_SECRET NOTION_TOKEN VAULT_ADDR
  export NOTION_SKIP_VAULT=1
  bash "$SCRIPT_PATH" me >/dev/null 2>"${TMP}/missing.err"
); then
  echo 'expected missing credentials to fail' >&2
  exit 1
fi
rg -F 'Vault lookup skipped via NOTION_SKIP_VAULT=1' "${TMP}/missing.err" >/dev/null

test "$(normalize_notion_id '309d69939e6d815eb960d3fc854d83d5')" = '309d6993-9e6d-815e-b960-d3fc854d83d5'
test "$(normalize_notion_id '309d6993-9e6d-815e-b960-d3fc854d83d5')" = '309d6993-9e6d-815e-b960-d3fc854d83d5'
test "$(normalize_notion_id 'https://www.notion.so/Eng-Post-Mortem-309d69939e6d815eb960d3fc854d83d5')" = '309d6993-9e6d-815e-b960-d3fc854d83d5'
test "$(normalize_notion_id 'https://www.notion.so/Team/Database-name-309d69939e6d815eb960d3fc854d83d5?v=22222222222222222222222222222222')" = '309d6993-9e6d-815e-b960-d3fc854d83d5'
test "$(normalize_notion_id 'https://www.notion.so/Page-309d69939e6d815eb960d3fc854d83d5#33333333333333333333333333333333')" = '309d6993-9e6d-815e-b960-d3fc854d83d5'
test "$(urlencode_preserving_pct_encoded 'f%5C%5C%3Ap')" = 'f%5C%5C%3Ap'
test "$(urlencode_preserving_pct_encoded 'status value')" = 'status%20value'
test "$(redact_secret '12345678')" = '***'
test "$(redact_secret '123456789')" = '1234...6789'

test "$(validate_page_size 1)" = '1'
test "$(validate_page_size 100)" = '100'
if (validate_page_size 0 >/dev/null 2>"${TMP}/page-size-zero.err"); then
  echo 'expected zero page-size to fail' >&2
  exit 1
fi
rg -F 'invalid --page-size: expected integer 1-100' "${TMP}/page-size-zero.err" >/dev/null
if (validate_page_size abc >/dev/null 2>"${TMP}/page-size-alpha.err"); then
  echo 'expected alpha page-size to fail' >&2
  exit 1
fi
rg -F 'invalid --page-size: expected integer 1-100' "${TMP}/page-size-alpha.err" >/dev/null
if (validate_page_size 101 >/dev/null 2>"${TMP}/page-size-large.err"); then
  echo 'expected large page-size to fail' >&2
  exit 1
fi
rg -F 'invalid --page-size: expected integer 1-100' "${TMP}/page-size-large.err" >/dev/null
if (
  export NOTION_SECRET='secret-token-abcdef'
  export NOTION_SKIP_VAULT=1
  bash "$SCRIPT_PATH" search >/dev/null 2>"${TMP}/missing-query.err"
); then
  echo 'expected missing search query to fail' >&2
  exit 1
fi
rg -F 'search --query is required' "${TMP}/missing-query.err" >/dev/null
if (normalize_notion_id 'not-a-notion-id' >/dev/null 2>"${TMP}/invalid-id.err"); then
  echo 'expected invalid notion id to fail' >&2
  exit 1
fi
rg -F 'invalid Notion id: not-a-notion-id' "${TMP}/invalid-id.err" >/dev/null
if (normalize_notion_id 'https://www.notion.so/no-id-here' >/dev/null 2>"${TMP}/missing-id.err"); then
  echo 'expected URL without notion id to fail' >&2
  exit 1
fi
rg -F 'failed to extract Notion id from URL' "${TMP}/missing-id.err" >/dev/null

export NOTION_SECRET='secret-token-abcdef'
export NOTION_SKIP_VAULT=1
export NOTION_CURL_BIN="$FAKE_CURL"
export NOTION_TEST_ARGS_LOG="${TMP}/page-get.args"
bash "$SCRIPT_PATH" page get 309d6993-9e6d-815e-b960-d3fc854d83d5 --filter-properties title,f%5C%5C%3Ap >/dev/null
rg -F 'filter_properties%5B%5D=title' "${TMP}/page-get.args" >/dev/null
rg -F 'filter_properties%5B%5D=f%5C%5C%3Ap' "${TMP}/page-get.args" >/dev/null
! rg -F 'filter_properties%5B%5D=f%255C%255C%253Ap' "${TMP}/page-get.args" >/dev/null

export NOTION_TEST_ARGS_LOG="${TMP}/data-source-query.args"
bash "$SCRIPT_PATH" data-source query 2a3746c2-e9bf-4e58-8421-fc3a4673cd82 --filter-properties title,f%5C%5C%3Ap >/dev/null
rg -F 'filter_properties%5B%5D=title' "${TMP}/data-source-query.args" >/dev/null
rg -F 'filter_properties%5B%5D=f%5C%5C%3Ap' "${TMP}/data-source-query.args" >/dev/null
! rg -F 'filter_properties%5B%5D=f%255C%255C%253Ap' "${TMP}/data-source-query.args" >/dev/null

export NOTION_TEST_ARGS_LOG="${TMP}/page-property.args"
bash "$SCRIPT_PATH" page property 309d6993-9e6d-815e-b960-d3fc854d83d5 f%5C%5C%3Ap >/dev/null
rg -F '/pages/309d6993-9e6d-815e-b960-d3fc854d83d5/properties/f%5C%5C%3Ap' "${TMP}/page-property.args" >/dev/null
! rg -F '/pages/309d6993-9e6d-815e-b960-d3fc854d83d5/properties/f%255C%255C%253Ap' "${TMP}/page-property.args" >/dev/null

probe_json="$(bash "$SCRIPT_PATH" --probe-auth)"
printf '%s\n' "$probe_json" | jq -e '.ok == true and .workspaceName == "Morpho"' >/dev/null

INVALID_JSON_CURL="${TMP}/invalid-json-curl.sh"
cat >"$INVALID_JSON_CURL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    -o)
      i=$((i + 1))
      output_file="${args[$i]}"
      ;;
  esac
  i=$((i + 1))
done

printf 'not-json' >"$output_file"
printf '200'
EOF
chmod +x "$INVALID_JSON_CURL"
if (
  export NOTION_SECRET='secret-token-abcdef'
  export NOTION_SKIP_VAULT=1
  export NOTION_CURL_BIN="$INVALID_JSON_CURL"
  bash "$SCRIPT_PATH" me >/dev/null 2>"${TMP}/invalid-json.err"
); then
  echo 'expected invalid JSON response to fail' >&2
  exit 1
fi
rg -F 'invalid JSON response from GET /users/me' "${TMP}/invalid-json.err" >/dev/null

HTTP_ERROR_CURL="${TMP}/http-error-curl.sh"
cat >"$HTTP_ERROR_CURL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    -o)
      i=$((i + 1))
      output_file="${args[$i]}"
      ;;
  esac
  i=$((i + 1))
done

printf '{"object":"error","code":"unauthorized","message":"API token is invalid."}' >"$output_file"
printf '401'
EOF
chmod +x "$HTTP_ERROR_CURL"
if (
  export NOTION_SECRET='secret-token-abcdef'
  export NOTION_SKIP_VAULT=1
  export NOTION_CURL_BIN="$HTTP_ERROR_CURL"
  bash "$SCRIPT_PATH" me >/dev/null 2>"${TMP}/http-error.err"
); then
  echo 'expected HTTP error response to fail' >&2
  exit 1
fi
rg -F 'GET /users/me failed (401, unauthorized): API token is invalid.' "${TMP}/http-error.err" >/dev/null

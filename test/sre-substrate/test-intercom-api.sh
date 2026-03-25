#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/skills/morpho-sre/intercom-api.sh"
LIB_PATH="${ROOT_DIR}/skills/morpho-sre/lib-intercom-api.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# shellcheck source=/dev/null
source "$LIB_PATH"

FAKE_CURL="${TMP}/fake-curl.sh"
cat >"$FAKE_CURL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >"${INTERCOM_TEST_ARGS_LOG:?}"

output_file=""
payload=""
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    -o)
      i=$((i + 1))
      output_file="${args[$i]}"
      ;;
    --data)
      i=$((i + 1))
      payload="${args[$i]}"
      ;;
  esac
  i=$((i + 1))
done

printf '%s\n' "$payload" >"${INTERCOM_TEST_PAYLOAD_LOG:-/dev/null}"

url="${args[$((${#args[@]} - 1))]}"
status_code="${INTERCOM_TEST_STATUS_CODE:-200}"
response='{"type":"list","data":[]}'

case "$url" in
  *'/me')
    response='{"id":"admin-1","name":"Test Admin","email":"admin@example.com","type":"admin"}'
    ;;
  *'/contacts/search')
    response='{"type":"contact.list","data":[]}'
    ;;
  *'/conversations/search')
    response='{"type":"conversation.list","conversations":[]}'
    ;;
  *'/tickets/search')
    response='{"type":"ticket.list","tickets":[]}'
    ;;
  *'/contacts'*)
    response='{"type":"contact.list","data":[]}'
    ;;
  *'/companies'*)
    response='{"type":"company.list","data":[]}'
    ;;
  *'/conversations'*)
    response='{"type":"conversation.list","conversations":[]}'
    ;;
  *'/ticket_types'*)
    response='{"type":"ticket_type.list","data":[]}'
    ;;
  *'/tickets/'*)
    response='{"type":"ticket","id":"ticket-1","ticket_id":"1234"}'
    ;;
esac

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
      case "${VAULT_RETURN_ERROR:-}" in
        missing_key)
          printf '{"data":{"data":{}}}\n'
          ;;
        malformed)
          printf 'not-json\n'
          ;;
        network)
          exit 28
          ;;
        *)
          printf '{"data":{"data":{"INTERCOM_SECRET":"vault-token-abcdef"}}}\n'
          ;;
      esac
      exit 0
      ;;
  esac
  prev="$arg"
done

printf '{"id":"admin-1","name":"Vault Admin","email":"vault@example.com","type":"admin"}\n'
EOF
chmod +x "$VAULT_CURL"

plan_secret="$(
  export INTERCOM_SECRET='secret-token-abcdef'
  export INTERCOM_SKIP_VAULT=1
  bash "$SCRIPT_PATH" --print-plan 2>/dev/null
)"
printf '%s\n' "$plan_secret" | jq -e '.credentialResolution == "OK"' >/dev/null
printf '%s\n' "$plan_secret" | jq -e '.credentialSource == "env:INTERCOM_SECRET"' >/dev/null
printf '%s\n' "$plan_secret" | jq -e '.baseUrl == "https://api.intercom.io"' >/dev/null
! printf '%s\n' "$plan_secret" | grep -q 'secret-token-abcdef'

plan_token="$(
  unset INTERCOM_SECRET
  export INTERCOM_TOKEN='fallback-token-abcdef'
  export INTERCOM_SKIP_VAULT=1
  bash "$SCRIPT_PATH" --print-plan 2>/dev/null
)"
printf '%s\n' "$plan_token" | jq -e '.credentialSource == "env:INTERCOM_TOKEN"' >/dev/null
! printf '%s\n' "$plan_token" | grep -q 'fallback-token-abcdef'

plan_vault_token="$(
  unset INTERCOM_SECRET INTERCOM_TOKEN
  export VAULT_ADDR='https://vault.test'
  export VAULT_TOKEN='cached-vault-token'
  export INTERCOM_CURL_BIN="$VAULT_CURL"
  bash "$SCRIPT_PATH" --print-plan 2>/dev/null
)"
printf '%s\n' "$plan_vault_token" | jq -e '.credentialSource == "vault:secret/data/openclaw-sre/all-secrets (cached token)"' >/dev/null
! printf '%s\n' "$plan_vault_token" | grep -q 'vault-token-abcdef'

detect_service_account_jwt() {
  printf '%s\n' "${TMP}/jwt"
}
printf '%s\n' 'jwt-token' >"${TMP}/jwt"
(
  unset INTERCOM_SECRET INTERCOM_TOKEN VAULT_TOKEN
  export VAULT_ADDR='https://vault.test'
  export OPENCLAW_SERVICE_ACCOUNT_NAME='gateway-role-only'
  export EXPECT_VAULT_ROLE='gateway-role-only'
  export INTERCOM_CURL_BIN="$VAULT_CURL"
  load_secret
  test "$INTERCOM_CREDENTIAL_SOURCE" = 'vault:secret/data/openclaw-sre/all-secrets (jwt auth)'
  test "$INTERCOM_ACTIVE_SECRET" = 'vault-token-abcdef'
)

test "$(default_intercom_base_url us)" = 'https://api.intercom.io'
test "$(default_intercom_base_url eu)" = 'https://api.eu.intercom.io'
test "$(default_intercom_base_url au)" = 'https://api.au.intercom.io'
test "$(validate_intercom_id '63a07ddf05a32042dffac965')" = '63a07ddf05a32042dffac965'
test "$(validate_intercom_id '991267921')" = '991267921'
test "$(validate_page_size 1)" = '1'
test "$(validate_page_size 150)" = '150'
test "$(validate_page_number 3)" = '3'
test "$(validate_starting_after 'cursor-1')" = 'cursor-1'

if (default_intercom_base_url bad >/dev/null 2>"${TMP}/bad-region.err"); then
  echo 'expected invalid region to fail' >&2
  exit 1
fi
rg -F 'unsupported INTERCOM_API_REGION: bad' "${TMP}/bad-region.err" >/dev/null

if (validate_page_size 151 >/dev/null 2>"${TMP}/per-page.err"); then
  echo 'expected large per-page to fail' >&2
  exit 1
fi
rg -F 'invalid --per-page: expected integer 1-150' "${TMP}/per-page.err" >/dev/null

validate_readonly_raw_path GET '/contacts'
validate_readonly_raw_path GET '/admins/activity_logs?page=1&per_page=5'
validate_readonly_raw_path POST '/contacts/search'
validate_readonly_raw_path POST '/companies/list'

if (validate_readonly_raw_path POST '/contacts' >/dev/null 2>"${TMP}/blocked-post.err"); then
  echo 'expected blocked Intercom mutation path' >&2
  exit 1
fi
rg -F 'blocked unsupported Intercom POST path: /contacts' "${TMP}/blocked-post.err" >/dev/null

if (validate_readonly_raw_path GET '/conversations/123/reply' >/dev/null 2>"${TMP}/blocked-get.err"); then
  echo 'expected blocked Intercom nested path' >&2
  exit 1
fi
rg -F 'blocked unsupported Intercom GET path: /conversations/123/reply' "${TMP}/blocked-get.err" >/dev/null

merged_search="$(merge_search_pagination '{"query":{"operator":"AND","value":[]}}' '10' 'cursor-123')"
printf '%s\n' "$merged_search" | jq -e '.pagination.per_page == 10 and .pagination.starting_after == "cursor-123"' >/dev/null

if (
  unset INTERCOM_SECRET INTERCOM_TOKEN VAULT_ADDR
  export INTERCOM_SKIP_VAULT=1
  bash "$SCRIPT_PATH" me >/dev/null 2>"${TMP}/missing.err"
); then
  echo 'expected missing credentials to fail' >&2
  exit 1
fi
rg -F 'Vault lookup skipped via INTERCOM_SKIP_VAULT=1' "${TMP}/missing.err" >/dev/null

if (
  export INTERCOM_SECRET='secret-token-abcdef'
  export INTERCOM_SKIP_VAULT=1
  export INTERCOM_API_BASE_URL='https://attacker.example.com'
  bash "$SCRIPT_PATH" --print-plan >/dev/null 2>"${TMP}/bad-host.err"
); then
  echo 'expected blocked Intercom host to fail' >&2
  exit 1
fi
rg -F 'blocked Intercom base host: attacker.example.com' "${TMP}/bad-host.err" >/dev/null

export INTERCOM_SECRET='secret-token-abcdef'
export INTERCOM_SKIP_VAULT=1
export INTERCOM_CURL_BIN="$FAKE_CURL"
export INTERCOM_TEST_ARGS_LOG="${TMP}/probe.args"
export INTERCOM_TEST_PAYLOAD_LOG="${TMP}/probe.payload"

probe_output="$(bash "$SCRIPT_PATH" --probe-auth)"
printf '%s\n' "$probe_output" | jq -e '.ok == true' >/dev/null
printf '%s\n' "$probe_output" | jq -e '.adminId == "admin-1"' >/dev/null
printf '%s\n' "$probe_output" | jq -e '.adminEmail == "admin@example.com"' >/dev/null
rg -F 'Authorization: Bearer secret-token-abcdef' "${TMP}/probe.args" >/dev/null
rg -F 'Intercom-Version: 2.14' "${TMP}/probe.args" >/dev/null
rg -F 'https://api.intercom.io/me' "${TMP}/probe.args" >/dev/null

export INTERCOM_TEST_ARGS_LOG="${TMP}/contacts-list.args"
bash "$SCRIPT_PATH" contacts list --per-page 25 --starting-after cursor-25 >/dev/null
rg -F 'https://api.intercom.io/contacts?per_page=25&starting_after=cursor-25' "${TMP}/contacts-list.args" >/dev/null

export INTERCOM_TEST_ARGS_LOG="${TMP}/companies-list.args"
bash "$SCRIPT_PATH" companies list --page 2 --per-page 15 --name 'Acme Co' --company-id external-123 >/dev/null
rg -F 'https://api.intercom.io/companies?page=2&per_page=15&name=Acme%20Co&company_id=external-123' "${TMP}/companies-list.args" >/dev/null

export INTERCOM_TEST_ARGS_LOG="${TMP}/contacts-search.args"
export INTERCOM_TEST_PAYLOAD_LOG="${TMP}/contacts-search.payload"
bash "$SCRIPT_PATH" contacts search --body '{"query":{"operator":"AND","value":[]}}' --per-page 10 --starting-after cursor-10 >/dev/null
rg -F 'https://api.intercom.io/contacts/search' "${TMP}/contacts-search.args" >/dev/null
printf '%s\n' "$(cat "${TMP}/contacts-search.payload")" | jq -e '.pagination.per_page == 10 and .pagination.starting_after == "cursor-10"' >/dev/null

export INTERCOM_TEST_ARGS_LOG="${TMP}/raw-get.args"
bash "$SCRIPT_PATH" raw get '/admins/activity_logs?page=1&per_page=5' >/dev/null
rg -F 'https://api.intercom.io/admins/activity_logs?page=1&per_page=5' "${TMP}/raw-get.args" >/dev/null

export INTERCOM_TEST_ARGS_LOG="${TMP}/raw-post.args"
export INTERCOM_TEST_PAYLOAD_LOG="${TMP}/raw-post.payload"
bash "$SCRIPT_PATH" raw post '/tickets/search' --body '{"query":{"operator":"AND","value":[]}}' >/dev/null
rg -F 'https://api.intercom.io/tickets/search' "${TMP}/raw-post.args" >/dev/null
printf '%s\n' "$(cat "${TMP}/raw-post.payload")" | jq -e '.query.operator == "AND"' >/dev/null

if bash "$SCRIPT_PATH" raw post '/contacts' --body '{"x":1}' >/dev/null 2>"${TMP}/raw-mutation.err"; then
  echo 'expected raw mutation path to fail' >&2
  exit 1
fi
rg -F 'blocked unsupported Intercom POST path: /contacts' "${TMP}/raw-mutation.err" >/dev/null

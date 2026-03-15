#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/skills/morpho-sre/single-vault-graphql-evidence.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BIN_WITH_CAST="${TMP}/bin-with-cast"
BIN_NO_CAST="${TMP}/bin-no-cast"
mkdir -p "$BIN_WITH_CAST" "$BIN_NO_CAST"

REAL_JQ="$(command -v jq)"
cat >"${BIN_WITH_CAST}/jq" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ "\${MOCK_JQ_FAIL_ARGJSON_RESPONSE:-0}" == "1" && " \$* " == *" --argjson response "* ]]; then
  printf '%s\n' 'mock jq response_summary failure' >&2
  exit 91
fi

exec "${REAL_JQ}" "\$@"
EOF
chmod +x "${BIN_WITH_CAST}/jq"
ln -sf "${BIN_WITH_CAST}/jq" "${BIN_NO_CAST}/jq"

cat >"${BIN_WITH_CAST}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
case "${MOCK_CURL_MODE:-success}" in
  success|partial-public-surface)
    if [[ "${MOCK_CURL_MODE:-success}" == "partial-public-surface" && "$payload" == *"vaultV2transactions"* ]]; then
      printf '%s\n' 'curl: (28) transactions probe timed out' >&2
      exit 28
    fi
    if [[ "$payload" == *"vaultV2transactions"* ]]; then
      printf '%s\n' '{"data":{"vaultV2transactions":{"items":[{"hash":"0xabc","type":"deposit"}]}}}'
      exit 0
    fi
    if [[ "$payload" == *"vaultV2s("* ]]; then
      printf '%s\n' '{"data":{"vaultV2s":{"items":[{"address":"0x123","name":"Mock Vault"}]}}}'
      exit 0
    fi
    printf '%s\n' '{"data":{"vaultV2ByAddress":{"address":"0x123","apy":"1.23"}}}'
    ;;
  invalid-json)
    printf '%s\n' '<html>gateway timeout</html>'
    ;;
  fail)
    printf '%s\n' "${MOCK_CURL_ERROR:-curl: (28) operation timed out}" >&2
    exit "${MOCK_CURL_EXIT_CODE:-28}"
    ;;
  *)
    printf 'unexpected MOCK_CURL_MODE: %s\n' "${MOCK_CURL_MODE:-}" >&2
    exit 97
    ;;
esac
EOF
chmod +x "${BIN_WITH_CAST}/curl"
ln -sf "${BIN_WITH_CAST}/curl" "${BIN_NO_CAST}/curl"

cat >"${BIN_WITH_CAST}/cast" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${MOCK_CAST_REQUIRE_END_OF_OPTIONS:-0}" == "1" && " $* " != *" -- ${EXPECTED_ADDRESS:-0x123} "* ]]; then
  printf 'missing -- before address: %s\n' "$*" >&2
  exit 95
fi

if [[ "${MOCK_CAST_MODE:-success}" == "fail" ]]; then
  printf '%s\n' "${MOCK_CAST_ERROR:-cast: rpc down}" >&2
  exit 1
fi

case "$*" in
  *"totalAssets()(uint256)"*)
    printf '%s\n' '123'
    ;;
  *"totalSupply()(uint256)"*)
    printf '%s\n' '456'
    ;;
  *)
    printf 'unexpected cast args: %s\n' "$*" >&2
    exit 96
    ;;
esac
EOF
chmod +x "${BIN_WITH_CAST}/cast"

ADDRESS='0x1234567890123456789012345678901234567890'
CONTROL_ADDRESS='0x4567890123456789012345678901234567890123'
QUERY='query SingleVaultByAddress($address: String!, $chainId: Int!) { vaultV2ByAddress(address: $address, chainId: $chainId) { address apy } }'
VARIABLES="{\"address\":\"${ADDRESS}\",\"chainId\":8453}"

plan_output="$(
  env PATH="${BIN_NO_CAST}:/usr/bin:/bin" \
    bash "$SCRIPT_PATH" \
      --address "$ADDRESS" \
      --chain-id 8453 \
      --query "$QUERY" \
      --variables-json "$VARIABLES" \
      --print-plan
)"

printf '%s\n' "$plan_output" | jq -e '
  .address == $address
  and .chain_id == 8453
  and (.probes | index("exact_query_replay")) != null
' --arg address "$ADDRESS" >/dev/null

success_output="$(
  env PATH="${BIN_WITH_CAST}:/usr/bin:/bin" \
    SINGLE_VAULT_RPC_URL='https://rpc.example' \
    MOCK_CURL_MODE=success \
    MOCK_CAST_MODE=success \
    bash "$SCRIPT_PATH" \
      --address "$ADDRESS" \
      --control-address "$CONTROL_ADDRESS" \
      --chain-id 8453 \
      --query "$QUERY" \
      --variables-json "$VARIABLES"
)"

printf '%s\n' "$success_output" | jq -e '
  .status == "ok"
  and .probes.exact_query_replay.ok == "yes"
  and .probes.same_chain_control.ok == "yes"
  and .probes.direct_rpc.status == "ok"
  and .probes.direct_rpc.totalAssets == "123"
  and .probes.direct_rpc.totalSupply == "456"
' >/dev/null

strict_cast_output="$(
  env PATH="${BIN_WITH_CAST}:/usr/bin:/bin" \
    SINGLE_VAULT_RPC_URL='https://rpc.example' \
    MOCK_CURL_MODE=success \
    MOCK_CAST_MODE=success \
    MOCK_CAST_REQUIRE_END_OF_OPTIONS=1 \
    EXPECTED_ADDRESS="$ADDRESS" \
    bash "$SCRIPT_PATH" \
      --address "$ADDRESS" \
      --chain-id 8453 \
      --query "$QUERY" \
      --variables-json "$VARIABLES"
)"

printf '%s\n' "$strict_cast_output" | jq -e '.probes.direct_rpc.status == "ok"' >/dev/null

help_output="$(bash "$SCRIPT_PATH" --help)"
printf '%s\n' "$help_output" | grep -F -- '--query ' >/dev/null
printf '%s\n' "$help_output" | grep -F -- '--variables-json ' >/dev/null
printf '%s\n' "$help_output" | grep -F -- 'SINGLE_VAULT_CURL_TIMEOUT_SECONDS' >/dev/null

missing_address_status=0
env PATH="${BIN_NO_CAST}:/usr/bin:/bin" bash "$SCRIPT_PATH" --chain-id 8453 --query "$QUERY" >/dev/null 2>&1 || missing_address_status=$?
test "$missing_address_status" = "2"

missing_chain_status=0
env PATH="${BIN_NO_CAST}:/usr/bin:/bin" bash "$SCRIPT_PATH" --address "$ADDRESS" --query "$QUERY" >/dev/null 2>&1 || missing_chain_status=$?
test "$missing_chain_status" = "2"

missing_query_status=0
env PATH="${BIN_NO_CAST}:/usr/bin:/bin" bash "$SCRIPT_PATH" --address "$ADDRESS" --chain-id 8453 >/dev/null 2>&1 || missing_query_status=$?
test "$missing_query_status" = "2"

missing_query_file_stderr="${TMP}/missing-query-file.stderr"
missing_query_file_status=0
env PATH="${BIN_NO_CAST}:/usr/bin:/bin" bash "$SCRIPT_PATH" --address "$ADDRESS" --chain-id 8453 --query-file "${TMP}/missing.graphql" > /dev/null 2>"$missing_query_file_stderr" || missing_query_file_status=$?
test "$missing_query_file_status" = "2"
grep -F 'query file not readable' "$missing_query_file_stderr" >/dev/null

non_numeric_chain_status=0
env PATH="${BIN_NO_CAST}:/usr/bin:/bin" bash "$SCRIPT_PATH" --address "$ADDRESS" --chain-id not-a-number --query "$QUERY" >/dev/null 2>&1 || non_numeric_chain_status=$?
test "$non_numeric_chain_status" = "2"

leading_zero_chain_stderr="${TMP}/leading-zero-chain.stderr"
leading_zero_chain_status=0
env PATH="${BIN_NO_CAST}:/usr/bin:/bin" bash "$SCRIPT_PATH" --address "$ADDRESS" --chain-id 007 --query "$QUERY" > /dev/null 2>"$leading_zero_chain_stderr" || leading_zero_chain_status=$?
test "$leading_zero_chain_status" = "2"
grep -F 'without leading zeros' "$leading_zero_chain_stderr" >/dev/null

invalid_address_stderr="${TMP}/invalid-address.stderr"
invalid_address_status=0
env PATH="${BIN_NO_CAST}:/usr/bin:/bin" bash "$SCRIPT_PATH" --address 0x123 --chain-id 8453 --query "$QUERY" > /dev/null 2>"$invalid_address_stderr" || invalid_address_status=$?
test "$invalid_address_status" = "2"
grep -F 'address must be a valid Ethereum address' "$invalid_address_stderr" >/dev/null

missing_cast_output="$(
  env PATH="${BIN_NO_CAST}:/usr/bin:/bin" \
    SINGLE_VAULT_RPC_URL='https://rpc.example' \
    MOCK_CURL_MODE=success \
    bash "$SCRIPT_PATH" \
      --address "$ADDRESS" \
      --chain-id 8453 \
      --query "$QUERY" \
      --variables-json "$VARIABLES"
)"

printf '%s\n' "$missing_cast_output" | jq -e '
  .probes.direct_rpc.status == "skipped"
  and .probes.direct_rpc.note == "rpc_url_missing_or_cast_unavailable"
' >/dev/null

missing_control_output="$(
  env PATH="${BIN_NO_CAST}:/usr/bin:/bin" \
    MOCK_CURL_MODE=success \
    bash "$SCRIPT_PATH" \
      --address "$ADDRESS" \
      --chain-id 8453 \
      --query "$QUERY" \
      --variables-json "$VARIABLES"
)"

printf '%s\n' "$missing_control_output" | jq -e '.probes.same_chain_control.ok == "skipped"' >/dev/null

invalid_json_output="$(
  env PATH="${BIN_NO_CAST}:/usr/bin:/bin" \
    MOCK_CURL_MODE=invalid-json \
    bash "$SCRIPT_PATH" \
      --address "$ADDRESS" \
      --chain-id 8453 \
      --query "$QUERY" \
      --variables-json "$VARIABLES"
)"

printf '%s\n' "$invalid_json_output" | jq -e '
  .status == "ok"
  and .probes.exact_query_replay.ok == "invalid_json_response"
  and .probes.exact_query_replay.first_error == "response was not valid JSON"
' >/dev/null

request_failed_output="$(
  env PATH="${BIN_NO_CAST}:/usr/bin:/bin" \
    MOCK_CURL_MODE=fail \
    MOCK_CURL_ERROR='curl: (28) operation timed out after 20001 milliseconds' \
    bash "$SCRIPT_PATH" \
      --address "$ADDRESS" \
      --chain-id 8453 \
      --query "$QUERY" \
      --variables-json "$VARIABLES"
)"

printf '%s\n' "$request_failed_output" | jq -e '
  .probes.exact_query_replay.ok == "request_failed"
  and (.probes.exact_query_replay.first_error | contains("operation timed out"))
' >/dev/null

jq_failure_tmp="${TMP}/jq-failure-tmp"
mkdir -p "$jq_failure_tmp"
response_summary_failure_stderr="${TMP}/response-summary-failure.stderr"
response_summary_failure_status=0
env PATH="${BIN_NO_CAST}:/usr/bin:/bin" \
  TMPDIR="$jq_failure_tmp" \
  MOCK_CURL_MODE=success \
  MOCK_JQ_FAIL_ARGJSON_RESPONSE=1 \
  bash "$SCRIPT_PATH" \
    --address "$ADDRESS" \
    --chain-id 8453 \
    --query "$QUERY" \
    --variables-json "$VARIABLES" >/dev/null 2>"$response_summary_failure_stderr" || response_summary_failure_status=$?
test "$response_summary_failure_status" != "0"
grep -F 'mock jq response_summary failure' "$response_summary_failure_stderr" >/dev/null
test -z "$(find "$jq_failure_tmp" -type f -print -quit)"

partial_surface_output="$(
  env PATH="${BIN_NO_CAST}:/usr/bin:/bin" \
    MOCK_CURL_MODE=partial-public-surface \
    bash "$SCRIPT_PATH" \
      --address "$ADDRESS" \
      --chain-id 8453 \
      --query "$QUERY" \
      --variables-json "$VARIABLES"
)"

printf '%s\n' "$partial_surface_output" | jq -e '
  .summary.public_surface_split == "failed"
  and .probes.minimal_by_address.ok == "yes"
  and .probes.vaultV2s_address_in.ok == "yes"
  and .probes.vaultV2transactions.ok == "request_failed"
' >/dev/null

rpc_failed_output="$(
  env PATH="${BIN_WITH_CAST}:/usr/bin:/bin" \
    SINGLE_VAULT_RPC_URL='https://rpc.example' \
    MOCK_CURL_MODE=success \
    MOCK_CAST_MODE=fail \
    MOCK_CAST_ERROR='cast: rpc down' \
    bash "$SCRIPT_PATH" \
      --address "$ADDRESS" \
      --chain-id 8453 \
      --query "$QUERY" \
      --variables-json "$VARIABLES"
)"

printf '%s\n' "$rpc_failed_output" | jq -e '
  .probes.direct_rpc.status == "failed"
  and (.probes.direct_rpc.first_error | contains("rpc down"))
  and (.probes.direct_rpc.totalAssetsError | contains("rpc down"))
  and (.probes.direct_rpc.totalSupplyError | contains("rpc down"))
' >/dev/null

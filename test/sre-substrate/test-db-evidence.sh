#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
SCRIPT="${ROOT}/db-evidence.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "${TMP_DIR}/bin"

cat >"${TMP_DIR}/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

dsn_b64='cG9zdGdyZXM6Ly9hZ2VudDpzZWNyZXRAZGIuZXhhbXBsZTo1NDMyL21vcnBobw==' # pragma: allowlist secret

if [[ "$*" == *"get secret -o json"* ]]; then
  cat <<JSON
{"items":[{"metadata":{"name":"morpho-indexer-db-secret"},"data":{"INDEXER_DATABASE_URL":"${dsn_b64}"}}]}
JSON
  exit 0
fi

if [[ "$*" == *"get secret morpho-indexer-db-secret -o json"* ]]; then
  cat <<JSON
{"metadata":{"name":"morpho-indexer-db-secret"},"data":{"INDEXER_DATABASE_URL":"${dsn_b64}"}}
JSON
  exit 0
fi

printf 'unexpected kubectl args: %s\n' "$*" >&2
exit 1
EOF
chmod +x "${TMP_DIR}/bin/kubectl"

cat >"${TMP_DIR}/bin/psql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

query=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-c" ]]; then
    query="${2:-}"
    break
  fi
  shift
done

case "$query" in
  *"WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2 LIMIT 20;"*)
    printf 'indexer\tblock_chain_8453\npublic\tvault_transfer\n'
    ;;
  *"WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"*"LIMIT 1;"*)
    printf 'indexer\tblock_chain_8453\n'
    ;;
  *"SELECT 1 FROM indexer.block_chain_8453 LIMIT 20;"*)
    printf '1\n1\n1\n'
    ;;
  *"SELECT 1 FROM \"indexer\".\"block_chain_8453\" LIMIT 20;"*)
    printf '1\n1\n1\n'
    ;;
  *"SELECT pg_is_in_recovery(),"*)
    printf 't\t4\n'
    ;;
  *"FROM pg_stat_activity;"*)
    printf '3\t1\n'
    ;;
  *"FROM pg_extension WHERE extname = 'pg_stat_statements';"*)
    printf '1\n'
    ;;
  *"FROM pg_stat_database_conflicts;"*)
    printf '12\n'
    ;;
  *"FROM pg_settings WHERE name IN ('max_connections','hot_standby_feedback','max_standby_streaming_delay')"*)
    printf 'hot_standby_feedback\ton\nmax_connections\t100\n'
    ;;
  *)
    printf 'unexpected query: %s\n' "$query" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${TMP_DIR}/bin/psql"

output="$(
  env PATH="${TMP_DIR}/bin:${PATH}" K8S_CONTEXT="test-context" DB_EVIDENCE_NAMESPACE="morpho-prd" \
    bash "$SCRIPT" --target indexer --mode summary
)"

printf '%s\n' "$output" | jq -e '
  .status == "ok"
  and .target == "indexer"
  and .namespace == "morpho-prd"
  and .schema_check == "ok"
  and .query_check == "ok"
  and .pg_internal_check == "ok"
  and .rows == 3
  and .db == "db.example:5432/morpho"
  and .replica == "t"
  and .replay_lag_s == "4"
  and (.evidence_line | contains("db=db.example:5432/morpho"))
' >/dev/null

plan_output="$(
  env PATH="${TMP_DIR}/bin:${PATH}" K8S_CONTEXT="test-context" \
    bash "$SCRIPT" --service morpho-blue-api-realtime-processor --print-plan
)"

printf '%s\n' "$plan_output" | jq -e '.target == "realtime"' >/dev/null

no_context_output="$(
  env PATH="${TMP_DIR}/bin:${PATH}" DB_EVIDENCE_NAMESPACE="morpho-prd" \
    bash "$SCRIPT" --target indexer --mode summary
)"

printf '%s\n' "$no_context_output" | jq -e '.status == "ok" and .target == "indexer"' >/dev/null

schema_output="$(
  env PATH="${TMP_DIR}/bin:${PATH}" K8S_CONTEXT="test-context" DB_EVIDENCE_NAMESPACE="morpho-prd" \
    bash "$SCRIPT" --target indexer --mode schema
)"

printf '%s\n' "$schema_output" | jq -e '
  .mode == "schema"
  and .schema_check == "ok"
  and .query_check == "ok"
  and .rows == 2
' >/dev/null

data_sql_output="$(
  env PATH="${TMP_DIR}/bin:${PATH}" K8S_CONTEXT="test-context" DB_EVIDENCE_NAMESPACE="morpho-prd" \
    bash "$SCRIPT" --target indexer --mode data --sql "SELECT 1 FROM indexer.block_chain_8453 LIMIT 20;"
)"

printf '%s\n' "$data_sql_output" | jq -e '
  .mode == "data"
  and .query_check == "ok"
  and .rows == 3
' >/dev/null

blocked_output="$(
  env PATH="${TMP_DIR}/bin:${PATH}" DB_EVIDENCE_NAMESPACE="morpho-prd" \
    bash "$SCRIPT" --secret missing-secret --mode summary 2>/dev/null || true
)"

printf '%s\n' "$blocked_output" | jq -e '.status == "blocked"' >/dev/null

unsupported_status=0
env PATH="${TMP_DIR}/bin:${PATH}" K8S_CONTEXT="test-context" \
  bash "$SCRIPT" --target indexer --mode unsupported >/dev/null 2>&1 || unsupported_status=$?
test "$unsupported_status" = "2"

#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
SCRIPT="${ROOT}/lib-db-target.sh"

source "$SCRIPT"

test "$(db_target_infer_from_service morpho-blue-api-realtime-processor)" = "realtime"
test "$(db_target_infer_from_service some-indexer-worker)" = "indexer"
test "$(db_target_infer_from_service blue-api)" = "blue_api"
test "$(db_target_qualify_host morpho-prd morpho-indexing-indexer-db-haproxy)" = "morpho-indexing-indexer-db-haproxy.morpho-prd.svc.cluster.local"
test "$(db_target_qualify_host morpho-prd db.example)" = "db.example"
test "$(db_target_parse_url 'postgres://user:pass@host:5432/dbname' | grep '^PGHOST=' | cut -d= -f2)" = "host" # pragma: allowlist secret

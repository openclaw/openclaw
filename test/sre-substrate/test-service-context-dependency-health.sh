#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
# shellcheck source=/dev/null
source "$ROOT/lib-service-graph.sh"
# shellcheck source=/dev/null
source "$ROOT/lib-service-context.sh"

GRAPH='{"morpho-dev/api":{"namespace":"morpho-dev","team":"ops","tier":"standard","depends_on":[{"service":"morpho-dev/postgres","edge_type":"depends-on","discovery_tier":"t1"}],"depended_by":[{"service":"morpho-dev/web","edge_type":"depends-on","discovery_tier":"t1"}]}}'
export SERVICE_DEPENDENCY_HEALTH_JSON='{"morpho-dev/postgres":{"status":"degraded","reason":"timeouts"},"morpho-dev/web":{"status":"degraded","reason":"5xx"}}'

ENRICHED="$(apply_service_dependency_health "$GRAPH")"
read_service_graph() { printf '{"services":%s}\n' "$ENRICHED"; }
SERVICE_CONTEXT_ENABLED=1
OUTPUT="$(assemble_service_context cluster morpho-dev api)"

printf '%s\n' "$OUTPUT" | grep -q 'Degraded dependencies:'
printf '%s\n' "$OUTPUT" | grep -q 'morpho-dev/postgres'
printf '%s\n' "$OUTPUT" | grep -q 'Likely cascades:'
printf '%s\n' "$OUTPUT" | grep -q 'morpho-dev/web'

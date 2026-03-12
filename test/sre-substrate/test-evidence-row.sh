#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../../skills/morpho-sre" && pwd)"

# shellcheck source=/dev/null
source "${ROOT_DIR}/lib-evidence-row.sh"

row="$(evidence_row_build "sentinel-triage" "incident_summary" "ns/category" "2026-03-07T00:00:00Z" '{"foo":"bar"}' "" "92" "600")"
row="$(printf '%s\n' "$row" | jq -c '.entity_ids = ["incident:abc"]')"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
out_file="${tmp_dir}/evidence.ndjson"
evidence_rows_write_ndjson "$out_file" "$row"

jq -e '
  .version == "sre.evidence-row.v1"
  and .source == "sentinel-triage"
  and .kind == "incident_summary"
  and .ttl_seconds == 600
  and .entity_ids == ["incident:abc"]
  and .payload.foo == "bar"
' <"$out_file" >/dev/null

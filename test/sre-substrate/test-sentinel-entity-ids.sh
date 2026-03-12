#!/usr/bin/env bash
set -euo pipefail

build_service_refs_json() {
  local workloads="${1:-}"
  printf '%s\n' "$workloads" \
    | awk -F'|' '{
        for (i = 1; i <= NF; i++) {
          if ($i != "") print "service:" $i
        }
      }' \
    | sort -u \
    | jq -R . \
    | jq -s .
}

jq -e '. == ["service:blue-api","service:blue-worker"]' <<<"$(build_service_refs_json "blue-api|blue-worker|")" >/dev/null
jq -e '. == []' <<<"$(build_service_refs_json "")" >/dev/null
jq -e '. == ["service:blue-api"]' <<<"$(build_service_refs_json "blue-api")" >/dev/null
jq -e '. == ["service:blue-api","service:blue-worker"]' <<<"$(build_service_refs_json "blue-api||blue-worker")" >/dev/null

printf 'PASS: sentinel entity ids include all workloads\n'

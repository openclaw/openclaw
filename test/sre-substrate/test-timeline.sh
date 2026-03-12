#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../../skills/morpho-sre" && pwd)"

# shellcheck source=/dev/null
source "${ROOT_DIR}/lib-timeline.sh"

older="$(timeline_event_build "kubernetes" "pod_restart" "morpho-dev/api" "2026-03-07T10:00:00Z" "warning" "pod restarted" '{"restart_count":2}')"
newer="$(timeline_event_build "argocd" "sync_change" "openclaw-sre" "2026-03-07T11:00:00Z" "critical" "argocd sync failed" '{"sync_status":"OutOfSync"}')"

merged="$(printf '%s\n%s\n' "$newer" "$older" | timeline_merge_sort_ndjson)"
first_line="$(printf '%s\n' "$merged" | sed -n '1p')"
summary="$(timeline_summary_block "$merged" 2)"

printf '%s\n' "$first_line" | jq -e '.event == "pod_restart"' >/dev/null
printf '%s\n' "$summary" | rg -F 'Recent change window:' >/dev/null
printf '%s\n' "$summary" | rg -F 'argocd sync failed' >/dev/null

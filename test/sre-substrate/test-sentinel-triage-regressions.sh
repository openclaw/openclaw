#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_SCRIPT="$REPO_ROOT/skills/morpho-sre/sentinel-triage.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-sre-sentinel-regressions.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

PARTIAL_SCRIPT="$TMP_ROOT/sentinel-triage.partial.sh"
END_LINE="$(grep -n '^emit_abort_output' "$TARGET_SCRIPT" | head -1 | cut -d: -f1)"
test -n "$END_LINE"
sed -n "1,$((END_LINE - 1))p" "$TARGET_SCRIPT" >"$PARTIAL_SCRIPT"

# shellcheck source=/dev/null
source "$PARTIAL_SCRIPT"

date() {
  case "$*" in
    "-u +%M")
      printf '08\n'
      ;;
    "-u +%Y%m%d%H")
      printf '2026031220\n'
      ;;
    *)
      command date "$@"
      ;;
  esac
}

dedup_key="$(compute_dedup_key "monitoring" "incident" "pod-a|pod-b")"
test -n "$dedup_key"
test "$dedup_key" = "$(compute_dedup_key "monitoring" "incident" "pod-a|pod-b")"

date() {
  case "$*" in
    "-u +%M")
      printf '38\n'
      ;;
    "-u +%Y%m%d%H")
      printf '2026031220\n'
      ;;
    *)
      command date "$@"
      ;;
  esac
}

dedup_key_half_30="$(compute_dedup_key "monitoring" "incident" "pod-a|pod-b")"
test -n "$dedup_key_half_30"
test "$dedup_key" != "$dedup_key_half_30"

test "$(normalize_json_compact_or '{"ok":true}' '{}')" = '{"ok":true}'
test "$(normalize_json_compact_or 'not-json' '{}')" = '{}'
test "$(normalize_json_compact_or '' '{}')" = '{}'
test "$(normalize_json_number_or '12.5' 0)" = '12.5'
test "$(normalize_json_number_or 'oops' 0)" = '0'
test "$(normalize_json_number_or '' 0)" = '0'
test "$(normalize_json_number_or '-3' 0)" = '-3'

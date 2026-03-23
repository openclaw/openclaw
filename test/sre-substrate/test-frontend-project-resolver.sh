#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/skills/morpho-sre/frontend-project-resolver.sh"

result="$(
  POSTHOG_PROJECT_MAP_PRD='{"landing":{"id":"111","aliases":["landing","morpho.org","marketing"]},"interface-v2":{"id":"222","aliases":["interface","app.morpho.org","consumer app"]}}' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing","morpho.org","marketing"]},"interface-v2":{"id":"22","aliases":["interface","app.morpho.org","consumer app"]}}' \
  "${SCRIPT_PATH}" prd "morpho.org landing page conversion dropped after deploy"
)"

printf '%s\n' "$result" | jq -e '.env == "prd"' >/dev/null
printf '%s\n' "$result" | jq -e '.posthog.top.key == "landing"' >/dev/null
printf '%s\n' "$result" | jq -e '.sentry.top.key == "landing"' >/dev/null
printf '%s\n' "$result" | jq -e '.posthog.top.config.id == "111"' >/dev/null
printf '%s\n' "$result" | jq -e '.sentry.top.config.id == "11"' >/dev/null

interface_result="$(
  POSTHOG_PROJECT_MAP_PRD='{"landing":{"id":"111","aliases":["landing","morpho.org","marketing"]},"interface-v2":{"id":"222","aliases":["interface v2","interface-v2","consumer app","app.morpho.org"]}}' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing","morpho.org","marketing"]},"interface-v2":{"id":"22","aliases":["interface v2","interface-v2","consumer app","app.morpho.org"]}}' \
  "${SCRIPT_PATH}" prd "consumer app interface v2 login broken"
)"

printf '%s\n' "$interface_result" | jq -e '.posthog.top.key == "interface-v2"' >/dev/null
printf '%s\n' "$interface_result" | jq -e '.sentry.top.key == "interface-v2"' >/dev/null

stdin_result="$(
  printf '%s' 'consumer app interface v2 login broken' \
    | env \
        POSTHOG_PROJECT_MAP_PRD='{"landing":{"id":"111","aliases":["landing","morpho.org","marketing"]},"interface-v2":{"id":"222","aliases":["interface v2","interface-v2","consumer app","app.morpho.org"]}}' \
        SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing","morpho.org","marketing"]},"interface-v2":{"id":"22","aliases":["interface v2","interface-v2","consumer app","app.morpho.org"]}}' \
        "${SCRIPT_PATH}" prd
)"

printf '%s\n' "$stdin_result" | jq -e '.posthog.top.key == "interface-v2"' >/dev/null
printf '%s\n' "$stdin_result" | jq -e '.sentry.top.key == "interface-v2"' >/dev/null

fallback="$(
  POSTHOG_PROJECT_ID_DEV='999' \
  SENTRY_PROJECT_SLUGS_DEV='landing,interface-v2' \
  "${SCRIPT_PATH}" dev "unknown prompt"
)"

printf '%s\n' "$fallback" | jq -e '.posthog.matches == []' >/dev/null
printf '%s\n' "$fallback" | jq -e '.sentry.matches == []' >/dev/null

if \
  POSTHOG_PROJECT_MAP_PRD='not-json' \
  "${SCRIPT_PATH}" prd "landing prompt" >/dev/null 2>&1; then
  echo 'expected invalid resolver project map failure' >&2
  exit 1
fi

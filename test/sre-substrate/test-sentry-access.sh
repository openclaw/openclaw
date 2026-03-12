#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SENTRY_CLI_SCRIPT="${ROOT_DIR}/skills/morpho-sre/sentry-cli.sh"
SENTRY_API_SCRIPT="${ROOT_DIR}/skills/morpho-sre/sentry-api.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat >"${TMP}/sentry-cli" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$SENTRY_URL"
printf '%s\n' "$SENTRY_ORG"
printf '%s\n' "${SENTRY_PROJECT:-}"
printf '%s\n' "$1"
EOF
chmod +x "${TMP}/sentry-cli"

cat >"${TMP}/mock-curl.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*"
EOF
chmod +x "${TMP}/mock-curl.sh"

cli_output="$(
  PATH="${TMP}:$PATH" \
  SENTRY_BASE_URL_DEV='https://sentry.io' \
  SENTRY_AUTH_TOKEN_DEV='dev-token' \
  SENTRY_ORG_SLUG_DEV='morpho-dev' \
  SENTRY_PROJECT_SLUGS_DEV='landing' \
  "${SENTRY_CLI_SCRIPT}" dev info
)"

printf '%s\n' "$cli_output" | sed -n '1p' | grep -Fx 'https://sentry.io' >/dev/null
printf '%s\n' "$cli_output" | sed -n '2p' | grep -Fx 'morpho-dev' >/dev/null
printf '%s\n' "$cli_output" | sed -n '3p' | grep -Fx 'landing' >/dev/null
printf '%s\n' "$cli_output" | sed -n '4p' | grep -Fx 'info' >/dev/null

if \
  PATH="${TMP}:$PATH" \
  SENTRY_BASE_URL_DEV='https://sentry.io' \
  SENTRY_AUTH_TOKEN_DEV='dev-token' \
  SENTRY_ORG_SLUG_DEV='morpho-dev' \
  SENTRY_PROJECT_SLUGS_DEV='landing,interface-v2' \
  "${SENTRY_CLI_SCRIPT}" dev --project forbidden info >/dev/null 2>&1; then
  echo 'expected blocked sentry-cli project' >&2
  exit 1
fi

if \
  PATH="${TMP}:$PATH" \
  SENTRY_BASE_URL_DEV='https://sentry.io' \
  SENTRY_AUTH_TOKEN_DEV='dev-token' \
  SENTRY_ORG_SLUG_DEV='morpho-dev' \
  SENTRY_PROJECT_SLUGS_DEV='landing,interface-v2' \
  "${SENTRY_CLI_SCRIPT}" dev --org wrong-org info >/dev/null 2>&1; then
  echo 'expected blocked sentry-cli org' >&2
  exit 1
fi

if \
  PATH="${TMP}:$PATH" \
  SENTRY_BASE_URL_DEV='https://sentry.io' \
  SENTRY_AUTH_TOKEN_DEV='dev-token' \
  SENTRY_ORG_SLUG_DEV='morpho-dev' \
  SENTRY_PROJECT_SLUGS_DEV='landing,interface-v2' \
  "${SENTRY_CLI_SCRIPT}" dev --project=forbidden info >/dev/null 2>&1; then
  echo 'expected blocked sentry-cli equals-style project' >&2
  exit 1
fi

if \
  PATH="${TMP}:$PATH" \
  SENTRY_BASE_URL_DEV='https://sentry.io' \
  SENTRY_AUTH_TOKEN_DEV='dev-token' \
  SENTRY_ORG_SLUG_DEV='morpho-dev' \
  SENTRY_PROJECT_SLUGS_DEV='landing,interface-v2' \
  "${SENTRY_CLI_SCRIPT}" dev --org=wrong-org info >/dev/null 2>&1; then
  echo 'expected blocked sentry-cli equals-style org' >&2
  exit 1
fi

if \
  PATH="${TMP}:$PATH" \
  SENTRY_BASE_URL_DEV='https://sentry.io' \
  SENTRY_AUTH_TOKEN_DEV='dev-token' \
  SENTRY_ORG_SLUG_DEV='morpho-dev' \
  SENTRY_PROJECT_SLUGS_DEV='landing,interface-v2' \
  "${SENTRY_CLI_SCRIPT}" dev -p forbidden info >/dev/null 2>&1; then
  echo 'expected blocked sentry-cli short project flag' >&2
  exit 1
fi

if \
  PATH="${TMP}:$PATH" \
  SENTRY_BASE_URL_DEV='https://sentry.io' \
  SENTRY_AUTH_TOKEN_DEV='dev-token' \
  SENTRY_ORG_SLUG_DEV='morpho-dev' \
  SENTRY_PROJECT_SLUGS_DEV='landing,interface-v2' \
  "${SENTRY_CLI_SCRIPT}" dev -o wrong-org info >/dev/null 2>&1; then
  echo 'expected blocked sentry-cli short org flag' >&2
  exit 1
fi

if \
  PATH="${TMP}:$PATH" \
  SENTRY_BASE_URL_DEV='https://sentry.io' \
  SENTRY_AUTH_TOKEN_DEV='dev-token' \
  SENTRY_ORG_SLUG_DEV='morpho-dev' \
  SENTRY_PROJECT_SLUGS_DEV='landing,interface-v2' \
  "${SENTRY_CLI_SCRIPT}" dev --url https://attacker.example.com info >/dev/null 2>&1; then
  echo 'expected blocked sentry-cli url override' >&2
  exit 1
fi

if \
  PATH="${TMP}:$PATH" \
  SENTRY_BASE_URL_DEV='https://sentry.io' \
  SENTRY_AUTH_TOKEN_DEV='dev-token' \
  SENTRY_ORG_SLUG_DEV='morpho-dev' \
  SENTRY_PROJECT_SLUGS_DEV='landing,interface-v2' \
  "${SENTRY_CLI_SCRIPT}" dev --auth-token fake info >/dev/null 2>&1; then
  echo 'expected blocked sentry-cli auth-token override' >&2
  exit 1
fi

api_output="$(
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":"22","aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/projects/morpho-prd/landing/issues/'
)"

printf '%s\n' "$api_output" | grep -F '/api/0/projects/morpho-prd/landing/issues/' >/dev/null

if \
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":22,"aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/projects/' >/dev/null 2>&1; then
  echo 'expected blocked sentry-api generic projects root' >&2
  exit 1
fi

if \
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":22,"aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/issues/123/events/' >/dev/null 2>&1; then
  echo 'expected blocked sentry-api unsupported issues path' >&2
  exit 1
fi

if \
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":22,"aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/1/organizations/morpho-prd/projects/' >/dev/null 2>&1; then
  echo 'expected blocked sentry-api invalid prefix' >&2
  exit 1
fi

project_root_output="$(
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":22,"aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/projects/morpho-prd/landing'
)"

printf '%s\n' "$project_root_output" | grep -F '/api/0/projects/morpho-prd/landing' >/dev/null

org_query_output="$(
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":"22","aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/organizations/morpho-prd/issues/?project=11'
)"

printf '%s\n' "$org_query_output" | grep -F '/api/0/organizations/morpho-prd/issues/?project=11' >/dev/null

org_query_slug_output="$(
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":"22","aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/organizations/morpho-prd/issues/?project=landing'
)"

printf '%s\n' "$org_query_slug_output" | grep -F '/api/0/organizations/morpho-prd/issues/?project=landing' >/dev/null

org_projects_output="$(
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":22,"aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/organizations/morpho-prd/projects/'
)"

printf '%s\n' "$org_projects_output" | grep -F '/api/0/organizations/morpho-prd/projects/' >/dev/null

if \
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":22,"aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/organizations/wrong-org/projects/' >/dev/null 2>&1; then
  echo 'expected blocked sentry-api wrong org path' >&2
  exit 1
fi

if \
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":"22","aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/projects/morpho-prd/forbidden/issues/' >/dev/null 2>&1; then
  echo 'expected blocked project slug' >&2
  exit 1
fi

if \
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":"22","aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/organizations/morpho-prd/issues/?project=999' >/dev/null 2>&1; then
  echo 'expected blocked project query id' >&2
  exit 1
fi

if \
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_PROJECT_MAP_PRD='{"landing":{"id":"11","aliases":["landing"]},"interface-v2":{"id":"22","aliases":["interface-v2"]}}' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/organizations/morpho-prd/issues/?project=forbidden' >/dev/null 2>&1; then
  echo 'expected blocked project query slug' >&2
  exit 1
fi

if \
  SENTRY_BASE_URL_PRD='https://sentry.io' \
  SENTRY_AUTH_TOKEN_PRD='prd-token' \
  SENTRY_ORG_SLUG_PRD='morpho-prd' \
  SENTRY_PROJECT_SLUGS_PRD='landing,interface-v2' \
  SENTRY_CURL_BIN="${TMP}/mock-curl.sh" \
  "${SENTRY_API_SCRIPT}" prd '/api/0/organizations/morpho-prd/issues/?project=11' >/dev/null 2>&1; then
  echo 'expected blocked project query id without map' >&2
  exit 1
fi

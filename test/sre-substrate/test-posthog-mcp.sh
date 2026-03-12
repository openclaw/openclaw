#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/skills/morpho-sre/posthog-mcp.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat >"${TMP}/mock-curl.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      output_file="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

printf 'HTTP/1.1 200 OK\r\n'
if [[ -n "$output_file" ]]; then
  printf '%s' '{"ok":true}' >"$output_file"
fi
EOF
chmod +x "${TMP}/mock-curl.sh"

plan_dev="$(
  export POSTHOG_HOST_DEV='https://us.posthog.com'
  export POSTHOG_PERSONAL_API_KEY_DEV='dev-secret' # pragma: allowlist secret
  export POSTHOG_PROJECT_MAP_DEV='{"landing":{"id":"123","aliases":["landing","morpho.org"]},"interface-v2":{"id":"456","aliases":["interface","app.morpho.org"]}}'
  "${SCRIPT_PATH}" dev --print-plan
)"

printf '%s\n' "$plan_dev" | jq -e '.env == "dev"' >/dev/null
printf '%s\n' "$plan_dev" | jq -e '.projectId == null' >/dev/null
printf '%s\n' "$plan_dev" | jq -e '.projectMapConfigured == true' >/dev/null
printf '%s\n' "$plan_dev" | jq -e '.host == "https://us.posthog.com"' >/dev/null
printf '%s\n' "$plan_dev" | jq -e '.args | index("Authorization: ${POSTHOG_MCP_AUTH_HEADER}") != null' >/dev/null
printf '%s\n' "$plan_dev" | jq -e '.url | contains("project_id=") | not' >/dev/null
printf '%s\n' "$plan_dev" | jq -e '.url | contains("read_only=true")' >/dev/null
printf '%s\n' "$plan_dev" | jq -e '.args | index("dev-secret") | not' >/dev/null

probe_prd="$(
  export POSTHOG_HOST_PRD='https://us.posthog.com'
  export POSTHOG_PERSONAL_API_KEY_PRD='prd-secret' # pragma: allowlist secret
  export POSTHOG_PROJECT_ID_PRD='999'
  export POSTHOG_MCP_CURL_BIN="${TMP}/mock-curl.sh"
  "${SCRIPT_PATH}" prd --probe-auth
)"

printf '%s\n' "$probe_prd" | jq -e '.ok == true' >/dev/null
printf '%s\n' "$probe_prd" | jq -e '.env == "prd"' >/dev/null
printf '%s\n' "$probe_prd" | jq -e '.projectId == "999"' >/dev/null

override_plan="$(
  export POSTHOG_HOST_PRD='https://eu.posthog.com'
  export POSTHOG_PERSONAL_API_KEY_PRD='prd-secret' # pragma: allowlist secret
  export POSTHOG_PROJECT_MAP_PRD='{"landing":{"id":"123","aliases":["landing"]},"interface-v2":{"id":"456","aliases":["interface v2"]}}'
  "${SCRIPT_PATH}" prd --project-id 456 --print-plan
)"

printf '%s\n' "$override_plan" | jq -e '.projectId == "456"' >/dev/null
printf '%s\n' "$override_plan" | jq -e '.url | contains("project_id=456")' >/dev/null

project_key_plan="$(
  export POSTHOG_HOST_PRD='https://eu.posthog.com'
  export POSTHOG_PERSONAL_API_KEY_PRD='prd-secret' # pragma: allowlist secret
  export POSTHOG_PROJECT_MAP_PRD='{"landing":{"id":"123","aliases":["landing"]},"vmv1":{"id":"456","aliases":["consumer app"]}}'
  "${SCRIPT_PATH}" prd --project-key vmv1 --print-plan
)"

printf '%s\n' "$project_key_plan" | jq -e '.projectId == "456"' >/dev/null
printf '%s\n' "$project_key_plan" | jq -e '.url | contains("project_id=456")' >/dev/null

legacy_probe="$(
  export POSTHOG_API_KEY='legacy-secret' # pragma: allowlist secret
  export POSTHOG_HOST='https://eu.posthog.com'
  export POSTHOG_PROJECT_ID_PRD='333'
  export POSTHOG_MCP_CURL_BIN="${TMP}/mock-curl.sh"
  "${SCRIPT_PATH}" prd --probe-auth
)"

printf '%s\n' "$legacy_probe" | jq -e '.ok == true' >/dev/null
printf '%s\n' "$legacy_probe" | jq -e '.url == "https://eu.posthog.com/api/projects/?limit=1"' >/dev/null

override_without_defaults="$(
  export POSTHOG_HOST_DEV='https://eu.posthog.com'
  export POSTHOG_PERSONAL_API_KEY_DEV='dev-secret' # pragma: allowlist secret
  "${SCRIPT_PATH}" dev --project-id 777 --print-plan
)"

printf '%s\n' "$override_without_defaults" | jq -e '.projectId == "777"' >/dev/null
printf '%s\n' "$override_without_defaults" | jq -e '.url | contains("project_id=777")' >/dev/null

cat >"${TMP}/mock-curl-fail.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 7
EOF
chmod +x "${TMP}/mock-curl-fail.sh"

failed_probe="$(
  export POSTHOG_HOST_PRD='https://eu.posthog.com'
  export POSTHOG_PERSONAL_API_KEY_PRD='prd-secret' # pragma: allowlist secret
  export POSTHOG_PROJECT_ID_PRD='999'
  export POSTHOG_MCP_CURL_BIN="${TMP}/mock-curl-fail.sh"
  "${SCRIPT_PATH}" prd --probe-auth
)"

printf '%s\n' "$failed_probe" | jq -e '.ok == false' >/dev/null
printf '%s\n' "$failed_probe" | jq -e '.bodyPreview == ""' >/dev/null
printf '%s\n' "$failed_probe" | jq -e '.curlExitCode == 7' >/dev/null

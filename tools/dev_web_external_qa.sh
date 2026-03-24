#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE_POLICY="${SCRIPT_DIR}/namespace_integrity.py"
PG_MEMORY_SCRIPT="${OPENCLAW_PG_MEMORY_PATH:-${SCRIPT_DIR}/pg_memory.py}"

# External web-delivery QA gate.

TASK_ID=""
BASE_URL=""
AUTH_PATH="/auth/start"
DASHBOARD_PATH="/dashboard"
MOBILE_PATH="/m"
NAMESPACE=""
FORCE_CROSS_PROJECT=0
FORCE_REASON=""
WORKDIR="${DEV_WORKDIR:-$(pwd)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-id) TASK_ID="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --auth-path) AUTH_PATH="$2"; shift 2 ;;
    --dashboard-path) DASHBOARD_PATH="$2"; shift 2 ;;
    --mobile-path) MOBILE_PATH="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --force-cross-project) FORCE_CROSS_PROJECT=1; shift ;;
    --reason) FORCE_REASON="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TASK_ID" || -z "$BASE_URL" ]]; then
  echo "Missing required args: --task-id and --base-url" >&2
  exit 2
fi

RESOLVE_CMD=(python3 "$NAMESPACE_POLICY" resolve-write --operation "dev_web_external_qa")
if [[ -n "$NAMESPACE" ]]; then
  RESOLVE_CMD+=(--namespace "$NAMESPACE")
fi
if [[ "$FORCE_CROSS_PROJECT" -eq 1 ]]; then
  RESOLVE_CMD+=(--force-cross-project)
fi
if [[ -n "$FORCE_REASON" ]]; then
  RESOLVE_CMD+=(--reason "$FORCE_REASON")
fi

set +e
RESOLUTION_JSON="$(${RESOLVE_CMD[@]} 2>&1)"
RESOLVE_RC=$?
set -e
if [[ $RESOLVE_RC -ne 0 ]]; then
  echo "$RESOLUTION_JSON" >&2
  exit $RESOLVE_RC
fi

NAMESPACE="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["namespace"])' <<<"$RESOLUTION_JSON")"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="/home/node/.openclaw/workspace/.runtime/dev-web-qa/${TASK_ID}/${TS}"
mkdir -p "$RUN_DIR"

normalize_url() {
  local base="$1"
  local path="$2"
  if [[ -z "$path" ]]; then
    echo "$base"
    return 0
  fi
  if [[ "$path" =~ ^https?:// ]]; then
    echo "$path"
    return 0
  fi
  if [[ "$path" == /* ]]; then
    echo "${base%/}${path}"
  else
    echo "${base%/}/$path"
  fi
}

check_url() {
  local label="$1"
  local url="$2"
  local ua="${3:-}"
  local code=""
  local log="$RUN_DIR/${label}.log"

  local curl_cmd=(curl -sS -o /dev/null -w "%{http_code}" -L --max-time 25)
  if [[ -n "$ua" ]]; then
    curl_cmd+=( -A "$ua" )
  fi
  set +e
  code="$("${curl_cmd[@]}" "$url" 2>"$log")"
  rc=$?
  set -e

  if [[ $rc -ne 0 ]]; then
    echo "fail|curl_error|$url"
    return 0
  fi

  if [[ "$code" =~ ^2[0-9][0-9]$ || "$code" =~ ^3[0-9][0-9]$ || "$code" == "401" || "$code" == "403" ]]; then
    echo "pass|$code|$url"
  else
    echo "fail|$code|$url"
  fi
}

HOME_URL="$(normalize_url "$BASE_URL" "/")"
AUTH_URL="$(normalize_url "$BASE_URL" "$AUTH_PATH")"
DASHBOARD_URL="$(normalize_url "$BASE_URL" "$DASHBOARD_PATH")"
MOBILE_URL="$(normalize_url "$BASE_URL" "$MOBILE_PATH")"

HOME_RES="$(check_url home "$HOME_URL")"
AUTH_RES="$(check_url auth_start "$AUTH_URL")"
DASH_RES="$(check_url dashboard "$DASHBOARD_URL")"
MOBILE_RES="$(check_url mobile "$MOBILE_URL" "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")"

overall="pass"
for res in "$HOME_RES" "$AUTH_RES" "$DASH_RES" "$MOBILE_RES"; do
  status="${res%%|*}"
  if [[ "$status" != "pass" ]]; then
    overall="fail"
    break
  fi
done

CONTENT=$(cat <<EOF

dev_web_external_qa_result v=1
task_id=${TASK_ID}
timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
workdir=${WORKDIR}
base_url=${BASE_URL}
overall=${overall}
home=${HOME_RES}
auth_start=${AUTH_RES}
dashboard=${DASH_RES}
mobile=${MOBILE_RES}
run_dir=${RUN_DIR}
rule=works_locally_but_broken_externally_is_failed_delivery
EOF
)

STORE_OUT="$(python3 "$PG_MEMORY_SCRIPT" store "$NAMESPACE" "$CONTENT" '["dev-web-external-qa", "task:'"$TASK_ID"'"]')"

if [[ "$overall" == "fail" ]]; then
  python3 "${SCRIPT_DIR}/dev_postmortem.py" \
    --task-id "$TASK_ID" \
    --phase "verification" \
    --summary "External web QA failed for real delivery URL path" \
    --root-cause "One or more external URL checks failed (home/auth/dashboard/mobile)" \
    --prevention "Run dev_web_external_qa gate before handoff; do not mark done until all external routes pass" \
    --artifacts "$RUN_DIR/home.log,$RUN_DIR/auth_start.log,$RUN_DIR/dashboard.log,$RUN_DIR/mobile.log" \
    --namespace "$NAMESPACE" >/dev/null
fi

echo "DEV_WEB_EXTERNAL_QA_RESULT overall=${overall} namespace=${NAMESPACE} run_dir=${RUN_DIR} store=${STORE_OUT}"

if [[ "$overall" == "fail" ]]; then
  exit 1
fi

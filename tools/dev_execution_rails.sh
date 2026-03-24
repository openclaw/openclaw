#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE_POLICY="${SCRIPT_DIR}/namespace_integrity.py"
PG_MEMORY_SCRIPT="${OPENCLAW_PG_MEMORY_PATH:-${SCRIPT_DIR}/pg_memory.py}"

# Run software-dev quality gates and store structured result in Postgres.

TASK_ID=""
NAMESPACE=""
FORCE_CROSS_PROJECT=0
FORCE_REASON=""
LINT_CMD="${DEV_LINT_CMD:-}"
TYPE_CMD="${DEV_TYPECHECK_CMD:-}"
TEST_CMD="${DEV_TEST_CMD:-}"
SMOKE_CMD="${DEV_SMOKE_CMD:-}"
WORKDIR="${DEV_WORKDIR:-$(pwd)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-id)
      TASK_ID="$2"; shift 2 ;;
    --namespace)
      NAMESPACE="$2"; shift 2 ;;
    --force-cross-project)
      FORCE_CROSS_PROJECT=1; shift ;;
    --reason)
      FORCE_REASON="$2"; shift 2 ;;
    --workdir)
      WORKDIR="$2"; shift 2 ;;
    --lint)
      LINT_CMD="$2"; shift 2 ;;
    --typecheck)
      TYPE_CMD="$2"; shift 2 ;;
    --test)
      TEST_CMD="$2"; shift 2 ;;
    --smoke)
      SMOKE_CMD="$2"; shift 2 ;;
    *)
      echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TASK_ID" ]]; then
  echo "Missing --task-id" >&2
  exit 2
fi

RESOLVE_CMD=(python3 "$NAMESPACE_POLICY" resolve-write --operation "dev_execution_rails")
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
RUN_DIR="/home/node/.openclaw/workspace/.runtime/dev-rails/${TASK_ID}/${TS}"
mkdir -p "$RUN_DIR"

run_gate() {
  local name="$1"
  local cmd="$2"
  local log="$RUN_DIR/${name}.log"

  if [[ -z "$cmd" ]]; then
    echo "SKIP: no command configured" > "$log"
    echo "skip"
    return 0
  fi

  set +e
  (cd "$WORKDIR" && bash -lc "$cmd") >"$log" 2>&1
  local rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    echo "pass"
  else
    echo "fail"
  fi
}

LINT_STATUS="$(run_gate lint "$LINT_CMD")"
TYPE_STATUS="$(run_gate typecheck "$TYPE_CMD")"
TEST_STATUS="$(run_gate test "$TEST_CMD")"
SMOKE_STATUS="$(run_gate smoke "$SMOKE_CMD")"

OVERALL="pass"
for s in "$LINT_STATUS" "$TYPE_STATUS" "$TEST_STATUS" "$SMOKE_STATUS"; do
  if [[ "$s" == "fail" ]]; then
    OVERALL="fail"
    break
  fi
done

FAIL_SNIPPETS=""
for gate in lint typecheck test smoke; do
  case "$gate" in
    lint) status="$LINT_STATUS" ;;
    typecheck) status="$TYPE_STATUS" ;;
    test) status="$TEST_STATUS" ;;
    smoke) status="$SMOKE_STATUS" ;;
  esac
  if [[ "$status" == "fail" ]]; then
    snippet="$(tail -n 25 "$RUN_DIR/${gate}.log" | tr '\n' ' ' | tr '\r' ' ' | sed 's/\s\+/ /g' | cut -c1-450)"
    FAIL_SNIPPETS+="${gate}:${snippet}; "
  fi
done

CONTENT=$(cat <<EOF

dev_execution_rails_result v=1
task_id=${TASK_ID}
timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
workdir=${WORKDIR}
overall=${OVERALL}
lint=${LINT_STATUS}
typecheck=${TYPE_STATUS}
test=${TEST_STATUS}
smoke=${SMOKE_STATUS}
run_dir=${RUN_DIR}
failure_snippets=${FAIL_SNIPPETS}
EOF
)

STORE_OUT="$(python3 "$PG_MEMORY_SCRIPT" store "$NAMESPACE" "$CONTENT" '["dev-execution-rails", "task:'"$TASK_ID"'"]')"

if [[ "$OVERALL" == "fail" ]]; then
  SUMMARY="Execution rails failed for ${TASK_ID}"
  ROOT_CAUSE="One or more quality gates failed (see stored rail result and logs)."
  PREVENTION="Address failing gates before merge; enforce same rails in CI."
  python3 "${SCRIPT_DIR}/dev_postmortem.py" \
    --task-id "$TASK_ID" \
    --phase "verification" \
    --summary "$SUMMARY" \
    --root-cause "$ROOT_CAUSE" \
    --prevention "$PREVENTION" \
    --artifacts "$RUN_DIR/lint.log,$RUN_DIR/typecheck.log,$RUN_DIR/test.log,$RUN_DIR/smoke.log" \
    --namespace "$NAMESPACE" >/dev/null
fi

echo "DEV_EXECUTION_RAILS_RESULT overall=${OVERALL} namespace=${NAMESPACE} run_dir=${RUN_DIR} store=${STORE_OUT}"

if [[ "$OVERALL" == "fail" ]]; then
  exit 1
fi

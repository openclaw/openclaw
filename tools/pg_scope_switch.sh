#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE_POLICY="${SCRIPT_DIR}/namespace_integrity.py"
PG_CHECKPOINT="${SCRIPT_DIR}/pg_checkpoint.py"

INIT_MODE=0
if [[ "${1:-}" == "--init" ]]; then
  INIT_MODE=1
  shift
fi

if [ "$#" -lt 3 ]; then
  echo "usage: $0 [--init] <from_namespace> <to_namespace> <reason> [next_step]" >&2
  exit 2
fi

FROM_NS="$1"
TO_NS="$2"
REASON="$3"
NEXT_STEP="${4:-Start work in target namespace and run pg_rehydrate.py}"

if [[ -z "$REASON" ]]; then
  echo '{"ok":false,"error":{"code":"SCOPE_SWITCH_REASON_REQUIRED","message":"reason must be non-empty"}}' >&2
  exit 3
fi

if [[ "$INIT_MODE" -ne 1 ]]; then
  set +e
  ACTIVE_JSON="$(python3 "$NAMESPACE_POLICY" get-active 2>&1)"
  ACTIVE_RC=$?
  set -e
  if [[ $ACTIVE_RC -ne 0 ]]; then
    echo "$ACTIVE_JSON" >&2
    exit $ACTIVE_RC
  fi
  ACTIVE_NS="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["namespace"])' <<<"$ACTIVE_JSON")"
  if [[ "$FROM_NS" != "$ACTIVE_NS" ]]; then
    echo "{\"ok\":false,\"error\":{\"code\":\"SCOPE_SWITCH_FROM_MISMATCH\",\"message\":\"from_namespace must equal active namespace\",\"details\":{\"fromNamespace\":\"$FROM_NS\",\"activeNamespace\":\"$ACTIVE_NS\"}}}" >&2
    exit 3
  fi

  python3 "$PG_CHECKPOINT" \
    --namespace "$FROM_NS" \
    --completed "Scope switch requested" \
    --decisions "Switching active scope to $TO_NS" \
    --next "$NEXT_STEP" \
    --extra-tags "scope-switch,handoff"

  # Only reached if checkpoint succeeded.
  python3 "$NAMESPACE_POLICY" set-active --namespace "$TO_NS" --reason "scope-switch" >/dev/null

  # Explicit scope-switch audit after successful active-namespace set.
  python3 "$NAMESPACE_POLICY" audit-event \
    --event "scope_switch_completed" \
    --code "SCOPE_SWITCH_COMPLETED" \
    --operation "pg_scope_switch" \
    --from-namespace "$FROM_NS" \
    --to-namespace "$TO_NS" \
    --reason "$REASON" >/dev/null
else
  python3 "$NAMESPACE_POLICY" set-active --namespace "$TO_NS" --reason "bootstrap" >/dev/null
  python3 "$NAMESPACE_POLICY" audit-event \
    --event "scope_switch_initialized" \
    --code "SCOPE_SWITCH_INITIALIZED" \
    --operation "pg_scope_switch" \
    --from-namespace "$FROM_NS" \
    --to-namespace "$TO_NS" \
    --reason "$REASON" >/dev/null
fi

echo "PG_SCOPE_SWITCH_OK from=$FROM_NS to=$TO_NS reason=$REASON"
echo "Run next: python3 ${SCRIPT_DIR}/pg_rehydrate.py --namespace $TO_NS --limit 5"

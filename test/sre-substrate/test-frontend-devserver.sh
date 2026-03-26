#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/skills/morpho-sre/frontend-devserver.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

assert_eq() {
  if [[ "$1" != "$2" ]]; then
    printf 'FAIL: expected [%s], got [%s] (%s)\n' "$2" "$1" "${3:-}" >&2
    ((++fail))
    return 1
  fi
  ((++pass))
  return 0
}

assert_contains() {
  if [[ "$1" != *"$2"* ]]; then
    printf 'FAIL: output does not contain [%s] (%s)\n' "$2" "${3:-}" >&2
    ((++fail))
    return 1
  fi
  ((++pass))
  return 0
}

assert_fail() {
  if eval "$@" >/dev/null 2>&1; then
    printf 'FAIL: expected failure but got success (%s)\n' "$*" >&2
    ((++fail))
    return 1
  fi
  ((++pass))
  return 0
}

# ── list command ──

list_out="$(bash "$SCRIPT" list)"

assert_contains "$list_out" "consumer-app" "list contains consumer-app"
assert_contains "$list_out" "curator-app" "list contains curator-app"
assert_contains "$list_out" "curator-v2-app" "list contains curator-v2-app"
assert_contains "$list_out" "delegate-app" "list contains delegate-app"
assert_contains "$list_out" "liquidation-app" "list contains liquidation-app"
assert_contains "$list_out" "markets-v2-app" "list contains markets-v2-app"
assert_contains "$list_out" "ui-app" "list contains ui-app"

# Verify correct ports match prime-monorepo hardcoded values.
assert_contains "$list_out" "4040" "curator-app port 4040"
assert_contains "$list_out" "3060" "curator-v2-app port 3060"
assert_contains "$list_out" "3030" "delegate-app port 3030"
assert_contains "$list_out" "3050" "liquidation-app port 3050"
assert_contains "$list_out" "3080" "markets-v2-app port 3080"
assert_contains "$list_out" "3090" "ui-app port 3090"
assert_contains "$list_out" "3000" "consumer-app port 3000"

# Verify repos.
assert_contains "$list_out" "morpho-org/prime-monorepo" "list contains prime-monorepo"
assert_contains "$list_out" "morpho-org/consumer-monorepo" "list contains consumer-monorepo"

# Exactly 7 app entries (header + 7 data rows).
line_count="$(printf '%s\n' "$list_out" | wc -l | tr -d ' ')"
assert_eq "$line_count" "8" "list has 8 lines (header + 7 apps)"

# ── help / usage ──

help_out="$(bash "$SCRIPT" --help 2>&1)"
assert_contains "$help_out" "frontend-devserver.sh start" "help contains start usage"
assert_contains "$help_out" "frontend-devserver.sh stop" "help contains stop usage"
assert_contains "$help_out" "frontend-devserver.sh status" "help contains status usage"

# ── unknown command ──

assert_fail "bash '$SCRIPT' bogus-command" "unknown command rejected"

# ── unknown app key ──

assert_fail "bash '$SCRIPT' start bogus-app" "unknown app key rejected"
assert_fail "bash '$SCRIPT' stop bogus-app" "unknown app key rejected (stop)"

# ── missing app key ──

assert_fail "bash '$SCRIPT' start" "missing app key rejected"
assert_fail "bash '$SCRIPT' stop" "missing app key rejected (stop)"

# ── port validation ──

assert_fail "bash '$SCRIPT' start consumer-app --port abc" "non-numeric port rejected"
assert_fail "bash '$SCRIPT' start consumer-app --port 0" "port 0 rejected"
assert_fail "bash '$SCRIPT' start consumer-app --port 99999" "port 99999 rejected"
assert_fail "bash '$SCRIPT' start consumer-app --port -1" "negative port rejected"

# ── --port rejected for prime-monorepo apps ──

port_reject_out="$(bash "$SCRIPT" start curator-app --port 5000 2>&1 || true)"
assert_contains "$port_reject_out" "only supported for consumer-app" "--port rejected for prime-monorepo"

port_reject_out2="$(bash "$SCRIPT" start markets-v2-app --port 5000 2>&1 || true)"
assert_contains "$port_reject_out2" "only supported for consumer-app" "--port rejected for markets-v2-app"

# ── --port accepted for consumer-app (will fail at clone, but past validation) ──

consumer_port_out="$(bash "$SCRIPT" start consumer-app --port 4000 2>&1 || true)"
# Should fail at repo-clone, not at port validation.
if [[ "$consumer_port_out" == *"only supported for consumer-app"* ]]; then
  printf 'FAIL: --port should be accepted for consumer-app\n' >&2
  ((++fail))
else
  ((++pass))
fi

# ── missing option values ──

assert_fail "bash '$SCRIPT' start consumer-app --port" "--port without value rejected"
assert_fail "bash '$SCRIPT' start consumer-app --env-file" "--env-file without value rejected"

# ── status with no running servers ──

status_out="$(STATE_DIR="$TMP/no-servers" bash "$SCRIPT" status 2>&1)"
assert_contains "$status_out" "APP KEY" "status prints header"

# ── stop with no running server (should exit 0) ──

STATE_DIR="$TMP/no-servers" bash "$SCRIPT" stop consumer-app 2>&1
assert_eq "$?" "0" "stop non-running exits 0"

# ── symlink resolution ──

# Create a symlink and verify the script works through it.
mkdir -p "$TMP/scripts"
ln -sf "$SCRIPT" "$TMP/scripts/frontend-devserver.sh"
symlink_out="$(bash "$TMP/scripts/frontend-devserver.sh" list)"
assert_contains "$symlink_out" "consumer-app" "symlink resolution works"

# ── state file lifecycle ──

# Simulate a state file with a dead PID and verify start detects it.
STATE_DIR="$TMP/state-test"
mkdir -p "$STATE_DIR"
cat >"${STATE_DIR}/consumer-app.json" <<'JSON'
{"pid": 999999999, "port": 3000, "url": "http://127.0.0.1:3000", "app_key": "consumer-app", "repo": "morpho-org/consumer-monorepo"}
JSON

# Status should show "dead" for the stale PID.
status_dead="$(STATE_DIR="$STATE_DIR" bash "$SCRIPT" status consumer-app 2>&1)"
assert_contains "$status_dead" "dead" "stale PID shows dead status"

# Stop should clean up the stale state file.
STATE_DIR="$STATE_DIR" bash "$SCRIPT" stop consumer-app 2>&1
if [[ -f "${STATE_DIR}/consumer-app.json" ]]; then
  printf 'FAIL: state file not cleaned up after stop\n' >&2
  ((++fail))
else
  ((++pass))
fi

# ── report ──

printf '\ntest-frontend-devserver: %d passed, %d failed\n' "$pass" "$fail"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi

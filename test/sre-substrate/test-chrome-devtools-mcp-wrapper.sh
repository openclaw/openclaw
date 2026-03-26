#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/skills/morpho-sre/chrome-devtools-mcp.sh"
TMP="$(mktemp -d)"
PIDS_TO_KILL=""
trap 'for p in $PIDS_TO_KILL; do kill "$p" 2>/dev/null || true; done; rm -rf "$TMP"' EXIT

pass=0
fail=0

assert_contains() {
  if [[ "$1" != *"$2"* ]]; then
    printf 'FAIL: output does not contain [%s] (%s)\n' "$2" "${3:-}" >&2
    ((++fail))
    return 1
  fi
  ((++pass))
  return 0
}

# ── syntax check ──

bash -n "$SCRIPT"
((++pass))

# Helper: create a mock bin directory for a test.
setup_mocks() {
  local dir="$1"
  mkdir -p "$dir/bin"

  # Mock sleep: instant for short values (readiness loop), real for long (chromium block).
  cat >"$dir/bin/sleep" <<'M'
#!/usr/bin/env bash
case "$1" in
  300|600) exec /bin/sleep "$1" ;;
  *) exit 0 ;;
esac
M
  chmod +x "$dir/bin/sleep"
}

# ── test 1: wrapper starts chromium when CDP is not available ──

setup_mocks "$TMP/t1"
CDP_READY="$TMP/t1/cdp-ready"
CHROMIUM_ARGS="$TMP/t1/chromium-args.txt"

# Mock chromium: record args, signal CDP ready, block via sleep.
cat >"$TMP/t1/bin/chromium" <<MOCK
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$CHROMIUM_ARGS"
touch "$CDP_READY"
exec sleep 300
MOCK
chmod +x "$TMP/t1/bin/chromium"

# Mock curl: fail until CDP ready, then succeed.
cat >"$TMP/t1/bin/curl" <<MOCK
#!/usr/bin/env bash
[[ -f "$CDP_READY" ]]
MOCK
chmod +x "$TMP/t1/bin/curl"

cat >"$TMP/t1/bin/chrome-devtools-mcp" <<'M'
#!/usr/bin/env bash
printf 'mcp-args: %s\n' "$*"
M
chmod +x "$TMP/t1/bin/chrome-devtools-mcp"

out1="$(env PATH="$TMP/t1/bin:$PATH" CDP_PORT=9333 bash "$SCRIPT" --extra-arg 2>&1)" || true

# Find and track any background sleep processes from mock chromium.
for p in $(pgrep -f "sleep 300" 2>/dev/null || true); do PIDS_TO_KILL="$PIDS_TO_KILL $p"; done

assert_contains "$out1" "mcp-args: --browserUrl http://127.0.0.1:9333 --extra-arg" \
  "MCP receives --browserUrl with correct port and extra args"

if [[ -f "$CHROMIUM_ARGS" ]]; then
  cargs="$(cat "$CHROMIUM_ARGS")"
  assert_contains "$cargs" "--headless=new" "chromium started headless"
  assert_contains "$cargs" "--no-sandbox" "chromium --no-sandbox"
  assert_contains "$cargs" "--remote-debugging-port=9333" "chromium correct CDP port"
  assert_contains "$cargs" "--disable-gpu" "chromium --disable-gpu"
  assert_contains "$cargs" "--disable-dev-shm-usage" "chromium --disable-dev-shm-usage"
  assert_contains "$cargs" "--user-data-dir=/tmp/chrome-devtools-data" "chromium data in /tmp"
else
  printf 'FAIL: chromium was not invoked\n' >&2
  ((++fail))
fi

# ── test 2: wrapper skips chromium if CDP already available ──

setup_mocks "$TMP/t2"
CHROMIUM_ARGS2="$TMP/t2/chromium-args.txt"

cat >"$TMP/t2/bin/curl" <<'M'
#!/usr/bin/env bash
exit 0
M
chmod +x "$TMP/t2/bin/curl"

cat >"$TMP/t2/bin/chromium" <<MOCK
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$CHROMIUM_ARGS2"
exec sleep 300
MOCK
chmod +x "$TMP/t2/bin/chromium"

cat >"$TMP/t2/bin/chrome-devtools-mcp" <<'M'
#!/usr/bin/env bash
printf 'mcp-args: %s\n' "$*"
M
chmod +x "$TMP/t2/bin/chrome-devtools-mcp"

out2="$(env PATH="$TMP/t2/bin:$PATH" CDP_PORT=9333 bash "$SCRIPT" 2>&1)" || true

assert_contains "$out2" "mcp-args:" "MCP launched when CDP pre-available"

if [[ -f "$CHROMIUM_ARGS2" ]]; then
  printf 'FAIL: chromium started even though CDP was already available\n' >&2
  ((++fail))
else
  ((++pass))
fi

# ── test 3: wrapper fails if chromium never becomes ready ──

setup_mocks "$TMP/t3"

cat >"$TMP/t3/bin/curl" <<'M'
#!/usr/bin/env bash
exit 1
M
chmod +x "$TMP/t3/bin/curl"

CHROME_PID_FILE3="$TMP/t3/chrome.pid"
cat >"$TMP/t3/bin/chromium" <<MOCK
#!/usr/bin/env bash
printf '%s\n' "\$\$" > "$CHROME_PID_FILE3"
exec sleep 300
MOCK
chmod +x "$TMP/t3/bin/chromium"

out3="$(env PATH="$TMP/t3/bin:$PATH" CDP_PORT=9444 bash "$SCRIPT" 2>&1 || true)"

for p in $(pgrep -f "sleep 300" 2>/dev/null || true); do PIDS_TO_KILL="$PIDS_TO_KILL $p"; done

assert_contains "$out3" "did not start within 15s" "wrapper reports timeout"

# Verify orphaned chromium was killed on timeout.
if [[ -f "$CHROME_PID_FILE3" ]]; then
  chrome3_pid="$(cat "$CHROME_PID_FILE3")"
  if [[ -n "$chrome3_pid" ]] && kill -0 "$chrome3_pid" 2>/dev/null; then
    printf 'FAIL: orphaned chromium (pid %s) still alive after timeout\n' "$chrome3_pid" >&2
    kill "$chrome3_pid" 2>/dev/null || true
    ((++fail))
  else
    ((++pass))
  fi
else
  ((++pass))
fi

# ── test 3b: wrapper fails fast if chromium not in PATH ──
# Skip if chromium is installed on the host (can't reliably hide it from command -v).
if ! command -v chromium >/dev/null 2>&1; then
  setup_mocks "$TMP/t3b"

  cat >"$TMP/t3b/bin/curl" <<'M'
#!/usr/bin/env bash
exit 1
M
  chmod +x "$TMP/t3b/bin/curl"

  cat >"$TMP/t3b/bin/chrome-devtools-mcp" <<'M'
#!/usr/bin/env bash
echo "should not reach"
M
  chmod +x "$TMP/t3b/bin/chrome-devtools-mcp"

  out3b="$(env PATH="$TMP/t3b/bin:$PATH" CDP_PORT=9555 bash "$SCRIPT" 2>&1 || true)"

  assert_contains "$out3b" "chromium binary not found" "fails fast when chromium missing"
else
  printf 'SKIP: chromium installed on host, cannot test missing-binary path\n' >&2
  ((++pass))
fi

# ── test 4: XDG env vars set to /tmp paths ──

setup_mocks "$TMP/t4"

cat >"$TMP/t4/bin/curl" <<'M'
#!/usr/bin/env bash
exit 0
M
chmod +x "$TMP/t4/bin/curl"

cat >"$TMP/t4/bin/chrome-devtools-mcp" <<'M'
#!/usr/bin/env bash
printf 'HOME=%s\n' "$HOME"
printf 'XDG_CONFIG_HOME=%s\n' "$XDG_CONFIG_HOME"
printf 'XDG_CACHE_HOME=%s\n' "$XDG_CACHE_HOME"
printf 'XDG_DATA_HOME=%s\n' "$XDG_DATA_HOME"
M
chmod +x "$TMP/t4/bin/chrome-devtools-mcp"

out4="$(env PATH="$TMP/t4/bin:$PATH" CDP_PORT=9333 bash "$SCRIPT" 2>&1)" || true

assert_contains "$out4" "HOME=/tmp/chrome-home" "HOME set to /tmp"
assert_contains "$out4" "XDG_CONFIG_HOME=/tmp/chrome-home/.config" "XDG_CONFIG_HOME under /tmp"
assert_contains "$out4" "XDG_CACHE_HOME=/tmp/chrome-home/.cache" "XDG_CACHE_HOME under /tmp"
assert_contains "$out4" "XDG_DATA_HOME=/tmp/chrome-home/.local/share" "XDG_DATA_HOME under /tmp"

# ── report ──

printf '\ntest-chrome-devtools-mcp-wrapper: %d passed, %d failed\n' "$pass" "$fail"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi

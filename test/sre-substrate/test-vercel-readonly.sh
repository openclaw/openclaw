#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_SCRIPT="$REPO_ROOT/skills/vercel/vercel-readonly.sh"
TMP="$(mktemp -d)"
NOAUTH_TMP="$(mktemp -d)"
TEST_TOKEN=$'te"st\\\\token with spaces\nand newlines'
trap 'rm -rf "$TMP" "$NOAUTH_TMP"' EXIT

MOCK_VERCEL="$TMP/vercel"
cat >"$MOCK_VERCEL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
  Darwin)
    auth_file="$HOME/Library/Application Support/com.vercel.cli/auth.json"
    cache_dir="$HOME/Library/Caches/com.vercel.cli/package-updates"
    auth_mode="$(stat -f '%Lp' "$auth_file")"
    ;;
  Linux)
    auth_file="$HOME/.config/com.vercel.cli/auth.json"
    cache_dir="$HOME/.cache/com.vercel.cli/package-updates"
    auth_mode="$(stat -c '%a' "$auth_file")"
    ;;
  *)
    echo "unsupported test os" >&2
    exit 1
    ;;
esac

test -f "$auth_file"
test -d "$cache_dir"
test "$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).token' "$auth_file")" = "$TEST_TOKEN"

printf '%s\n' "$HOME" >"$TEST_TMP/observed-home"
printf '%s\n' "$auth_mode" >"$TEST_TMP/observed-auth-mode"
printf '%s\n' "$*" >"$TEST_TMP/observed-args"
EOF
chmod +x "$MOCK_VERCEL"

EVIL_VERCEL="$TMP/evil-vercel.sh"
cat >"$EVIL_VERCEL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

echo evil >&2
exit 99
EOF
chmod +x "$EVIL_VERCEL"

NOAUTH_NODE="$NOAUTH_TMP/node"
cat >"$NOAUTH_NODE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

exit 0
EOF
chmod +x "$NOAUTH_NODE"

NOAUTH_VERCEL="$NOAUTH_TMP/vercel"
cat >"$NOAUTH_VERCEL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'ran\n' >"$TEST_TMP/ran-vercel"
exit 99
EOF
chmod +x "$NOAUTH_VERCEL"

if AUTH_JSON_PATH="$NOAUTH_TMP/missing/auth.json" TOKEN_TO_JSON="$TEST_TOKEN" node "$REPO_ROOT/skills/vercel/write-auth-json.mjs" 2>"$NOAUTH_TMP/write-auth.err"; then
  echo "expected direct helper write to fail for missing parent dir" >&2
  exit 1
fi
rg -F 'Failed to write auth file:' "$NOAUTH_TMP/write-auth.err" >/dev/null

if TOKEN_TO_JSON="$TEST_TOKEN" node "$REPO_ROOT/skills/vercel/write-auth-json.mjs" 2>"$NOAUTH_TMP/missing-auth-path.err"; then
  echo "expected helper to require AUTH_JSON_PATH" >&2
  exit 1
fi
rg -F 'AUTH_JSON_PATH environment variable is required' "$NOAUTH_TMP/missing-auth-path.err" >/dev/null

if AUTH_JSON_PATH="$NOAUTH_TMP/direct/auth.json" node "$REPO_ROOT/skills/vercel/write-auth-json.mjs" 2>"$NOAUTH_TMP/missing-token.err"; then
  echo "expected helper to require TOKEN_TO_JSON" >&2
  exit 1
fi
rg -F 'TOKEN_TO_JSON environment variable is required' "$NOAUTH_TMP/missing-token.err" >/dev/null

PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" teams list --format json --scope demo
test "$(cat "$TMP/observed-args")" = 'teams list --format json --scope demo'
test "$(cat "$TMP/observed-auth-mode")" = '600'
OBSERVED_HOME="$(cat "$TMP/observed-home")"
test ! -d "$OBSERVED_HOME"

PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" help
test "$(cat "$TMP/observed-args")" = 'help'

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" "" 2>"$TMP/empty.err"; then
  echo "expected empty command to be blocked" >&2
  exit 1
fi
rg -F 'usage: vercel-readonly.sh COMMAND [FLAGS...] - read-only wrapper allows only: help, whoami, teams list, ls, inspect, logs, domains ls' "$TMP/empty.err" >/dev/null

PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_BIN="$EVIL_VERCEL" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" whoami
test "$(cat "$TMP/observed-args")" = 'whoami'

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" deploy 2>"$TMP/deploy.err"; then
  echo "expected deploy to be blocked" >&2
  exit 1
fi
rg -F 'read-only wrapper allows only: help, whoami, teams list, ls, inspect, logs, domains ls' "$TMP/deploy.err" >/dev/null

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" teams rm 2>"$TMP/teams-rm.err"; then
  echo "expected teams rm to be blocked" >&2
  exit 1
fi
rg -F 'read-only wrapper allows only: teams list' "$TMP/teams-rm.err" >/dev/null

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" domains add example.com 2>"$TMP/domains-add.err"; then
  echo "expected domains add to be blocked" >&2
  exit 1
fi
rg -F 'read-only wrapper allows only: domains ls' "$TMP/domains-add.err" >/dev/null

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" whoami --token nope 2>"$TMP/token.err"; then
  echo "expected --token to be blocked" >&2
  exit 1
fi
rg -F 'do not pass --token' "$TMP/token.err" >/dev/null

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" whoami --token=nope 2>"$TMP/token-equals.err"; then
  echo "expected --token=... to be blocked" >&2
  exit 1
fi
rg -F 'do not pass --token' "$TMP/token-equals.err" >/dev/null

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" whoami -t nope 2>"$TMP/token-short.err"; then
  echo "expected -t to be blocked" >&2
  exit 1
fi
rg -F 'do not pass --token' "$TMP/token-short.err" >/dev/null

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" whoami -tnope 2>"$TMP/token-short-concat.err"; then
  echo "expected -tVALUE to be blocked" >&2
  exit 1
fi
rg -F 'do not pass --token' "$TMP/token-short-concat.err" >/dev/null

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" whoami -t=nope 2>"$TMP/token-short-equals.err"; then
  echo "expected -t=... to be blocked" >&2
  exit 1
fi
rg -F 'do not pass --token' "$TMP/token-short-equals.err" >/dev/null

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" whoami --exec=sh 2>"$TMP/exec-flag.err"; then
  echo "expected --exec=... to be blocked" >&2
  exit 1
fi
rg -F 'command-execution flags are not allowed in read-only mode: --exec=sh' "$TMP/exec-flag.err" >/dev/null

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" logs demo --command sh 2>"$TMP/command-flag.err"; then
  echo "expected --command to be blocked" >&2
  exit 1
fi
rg -F 'command-execution flags are not allowed in read-only mode: --command' "$TMP/command-flag.err" >/dev/null

if PATH="$TMP:$PATH" TEST_TMP="$TMP" TEST_TOKEN="$TEST_TOKEN" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" --scope ls deploy 2>"$TMP/order.err"; then
  echo "expected flags-before-command bypass to be blocked" >&2
  exit 1
fi
rg -F 'put the allowed vercel command first' "$TMP/order.err" >/dev/null

if PATH="$NOAUTH_TMP:$PATH" TEST_TMP="$NOAUTH_TMP" VERCEL_TOKEN="$TEST_TOKEN" bash "$TARGET_SCRIPT" whoami 2>"$NOAUTH_TMP/noauth.err"; then
  echo "expected missing auth file to be blocked" >&2
  exit 1
fi
rg -F 'auth file was not created at expected path:' "$NOAUTH_TMP/noauth.err" >/dev/null
test ! -e "$NOAUTH_TMP/ran-vercel"

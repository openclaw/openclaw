#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_SCRIPT="$REPO_ROOT/skills/morpho-sre/autofix-pr.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PARTIAL_SCRIPT="$TMP/autofix-pr.partial.sh"
END_LINE="$(grep -n '^REPO_INPUT=""' "$TARGET_SCRIPT" | head -1 | cut -d: -f1)"
test -n "$END_LINE"
sed -n "1,$((END_LINE - 1))p" "$TARGET_SCRIPT" >"$PARTIAL_SCRIPT"

# shellcheck source=/dev/null
source "$PARTIAL_SCRIPT"

REPO_SLUG="morpho-org/openclaw-sre"
READONLY_BOT_EMAIL='264278285+prd-carapulse[bot]@users.noreply.github.com'

reset_auth_state() {
  RESOLVED_AUTH_TOKEN=""
  RESOLVED_AUTH_TOKEN_SOURCE=""
  AUTH_TOKEN=""
  AUTH_TOKEN_SOURCE=""
  AUTO_PR_AUTOFIX_GITHUB_APP_TOKEN_CACHE=""
  AUTO_PR_AUTOFIX_GITHUB_APP_TOKEN_CACHE_EPOCH="0"
  git_auth_basic=""
  GITHUB_REPO_ACCESS_LAST_CODE=""
  unset GITHUB_TOKEN GH_TOKEN AUTO_PR_GITHUB_APP_TOKEN_CACHE_TTL
}

reset_auth_state
touch "$TMP/probe.log"
probe_log="$TMP/probe.log"
mint_github_app_token() {
  printf '%s\n' 'app-token'
}
github_repo_access_ok() {
  printf '%s\n' "$1" >>"$probe_log"
  GITHUB_REPO_ACCESS_LAST_CODE="200"
  return 0
}

export GITHUB_TOKEN="user-token"
export GH_TOKEN="gh-user-token"
resolve_github_app_token_for_repo "$REPO_SLUG"
test "$RESOLVED_AUTH_TOKEN" = 'app-token'
test "$RESOLVED_AUTH_TOKEN_SOURCE" = 'github_app'
test "$(wc -l <"$probe_log" | tr -d '[:space:]')" = '1'
test "$(cat "$probe_log")" = 'app-token'

reset_auth_state
touch "$TMP/cache.log"
probe_log="$TMP/cache.log"
mint_github_app_token() {
  return 1
}
github_repo_access_ok() {
  GITHUB_REPO_ACCESS_LAST_CODE="200"
  return 0
}
if resolve_github_app_token_for_repo "$REPO_SLUG" >/dev/null 2>"$TMP/mint.err"; then
  echo "expected resolve_github_app_token_for_repo to fail without app token" >&2
  exit 1
fi
rg -F 'verified bot commits require GitHub App credentials' "$TMP/mint.err" >/dev/null
rg -F 'GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID' "$TMP/mint.err" >/dev/null

reset_auth_state
mint_github_app_token() {
  printf '%s\n' 'app-token'
}
github_repo_access_ok() {
  GITHUB_REPO_ACCESS_LAST_CODE="403"
  return 1
}
if resolve_github_app_token_for_repo "$REPO_SLUG" >/dev/null 2>"$TMP/access.err"; then
  echo "expected resolve_github_app_token_for_repo to fail on repo access denial" >&2
  exit 1
fi
rg -F 'verified bot commits require GitHub App repo access' "$TMP/access.err" >/dev/null

reset_auth_state
touch "$TMP/cache.log"
probe_log="$TMP/cache.log"
mint_log="$TMP/mint-cache.log"
touch "$mint_log"
mint_github_app_token() {
  printf '%s\n' 'minted' >>"$mint_log"
  printf '%s\n' 'cached-app-token'
}
github_repo_access_ok() {
  printf '%s\n' "$1" >>"$probe_log"
  GITHUB_REPO_ACCESS_LAST_CODE="200"
  return 0
}
resolve_github_app_token_for_repo "$REPO_SLUG"
resolve_github_app_token_for_repo "$REPO_SLUG"
test "$(wc -l <"$mint_log" | tr -d '[:space:]')" = '1'
test "$(wc -l <"$probe_log" | tr -d '[:space:]')" = '1'
test "$RESOLVED_AUTH_TOKEN" = 'cached-app-token'

reset_auth_state
touch "$TMP/stale-cache.log"
probe_log="$TMP/stale-cache.log"
mint_log="$TMP/stale-mint.log"
touch "$mint_log"
AUTO_PR_AUTOFIX_GITHUB_APP_TOKEN_CACHE='stale-token'
AUTO_PR_AUTOFIX_GITHUB_APP_TOKEN_CACHE_EPOCH='1'
mint_github_app_token() {
  printf '%s\n' 'minted' >>"$mint_log"
  printf '%s\n' 'fresh-token'
}
github_repo_access_ok() {
  printf '%s\n' "$1" >>"$probe_log"
  GITHUB_REPO_ACCESS_LAST_CODE="200"
  return 0
}
resolve_github_app_token_for_repo "$REPO_SLUG"
test "$RESOLVED_AUTH_TOKEN" = 'fresh-token'
test "$(cat "$mint_log")" = 'minted'
test "$(cat "$probe_log")" = 'fresh-token'

reset_auth_state
touch "$TMP/custom-ttl.log"
probe_log="$TMP/custom-ttl.log"
mint_log="$TMP/custom-ttl-mint.log"
touch "$mint_log"
AUTO_PR_GITHUB_APP_TOKEN_CACHE_TTL='1'
AUTO_PR_AUTOFIX_GITHUB_APP_TOKEN_CACHE='expired-token'
AUTO_PR_AUTOFIX_GITHUB_APP_TOKEN_CACHE_EPOCH="$(( $(date +%s) - 2 ))"
mint_github_app_token() {
  printf '%s\n' 'minted' >>"$mint_log"
  printf '%s\n' 'ttl-refresh-token'
}
github_repo_access_ok() {
  printf '%s\n' "$1" >>"$probe_log"
  GITHUB_REPO_ACCESS_LAST_CODE="200"
  return 0
}
resolve_github_app_token_for_repo "$REPO_SLUG"
test "$RESOLVED_AUTH_TOKEN" = 'ttl-refresh-token'
test "$(cat "$mint_log")" = 'minted'
test "$(cat "$probe_log")" = 'ttl-refresh-token'

reset_auth_state
TMPDIR="$TMP"
refresh_log="$TMP/retry-refresh.log"
attempt_log="$TMP/retry-attempt.log"
touch "$refresh_log" "$attempt_log"
git_auth_basic='initial-auth'
refresh_auth_context() {
  printf '%s\n' 'refresh' >>"$refresh_log"
  git_auth_basic='refreshed-auth'
  return 0
}
create_api_signed_commit() {
  printf '%s\n' "$6" >>"$attempt_log"
  if [[ "$(wc -l <"$attempt_log" | tr -d '[:space:]')" -eq 1 ]]; then
    echo 'authentication failed' >&2
    return 1
  fi
  test "$6" = 'refreshed-auth'
  printf '%s\n' '{"data":{"createCommitOnBranch":{"commit":{"url":"https://example.test/commit","oid":"abc123"}}}}'
}
create_api_signed_commit_with_retry '/tmp/repo' "$REPO_SLUG" main feature/test 'msg' "$git_auth_basic" >"$TMP/retry.out" 2>"$TMP/retry.err"
test "$(wc -l <"$refresh_log" | tr -d '[:space:]')" = '1'
test "$(wc -l <"$attempt_log" | tr -d '[:space:]')" = '2'
test "$(sed -n '1p' "$attempt_log")" = 'initial-auth'
test "$(sed -n '2p' "$attempt_log")" = 'refreshed-auth'
test "$(cat "$TMP/retry.out")" = '{"data":{"createCommitOnBranch":{"commit":{"url":"https://example.test/commit","oid":"abc123"}}}}'
rg -F 'initial signed commit attempt failed; refreshing auth and retrying' "$TMP/retry.err" >/dev/null
rg -F 'authentication failed' "$TMP/retry.err" >/dev/null

reset_auth_state
TMPDIR="$TMP"
refresh_log="$TMP/retry-fail-refresh.log"
attempt_log="$TMP/retry-fail-attempt.log"
touch "$refresh_log" "$attempt_log"
git_auth_basic='initial-auth'
refresh_auth_context() {
  printf '%s\n' 'refresh' >>"$refresh_log"
  return 1
}
create_api_signed_commit() {
  printf '%s\n' "$6" >>"$attempt_log"
  echo 'authentication failed' >&2
  return 1
}
if create_api_signed_commit_with_retry '/tmp/repo' "$REPO_SLUG" main feature/test 'msg' "$git_auth_basic" >/dev/null 2>"$TMP/retry-fail.err"; then
  echo "expected create_api_signed_commit_with_retry to fail after refresh failure" >&2
  exit 1
fi
test "$(wc -l <"$refresh_log" | tr -d '[:space:]')" = '1'
test "$(wc -l <"$attempt_log" | tr -d '[:space:]')" = '1'
rg -F 'initial signed commit attempt failed; refreshing auth and retrying' "$TMP/retry-fail.err" >/dev/null
rg -F 'authentication failed' "$TMP/retry-fail.err" >/dev/null

reset_auth_state
TMPDIR="$TMP"
refresh_log="$TMP/non-auth-refresh.log"
attempt_log="$TMP/non-auth-attempt.log"
touch "$refresh_log" "$attempt_log"
git_auth_basic='same-auth'
refresh_auth_context() {
  printf '%s\n' 'refresh' >>"$refresh_log"
  return 0
}
create_api_signed_commit() {
  printf '%s\n' "$6" >>"$attempt_log"
  if [[ "$(wc -l <"$attempt_log" | tr -d '[:space:]')" -eq 1 ]]; then
    echo 'head oid mismatch' >&2
    return 1
  fi
  test "$6" = 'same-auth'
  printf '%s\n' '{"data":{"createCommitOnBranch":{"commit":{"url":"https://example.test/commit","oid":"def456"}}}}'
}
create_api_signed_commit_with_retry '/tmp/repo' "$REPO_SLUG" main feature/test 'msg' "$git_auth_basic" >"$TMP/non-auth-retry.out" 2>"$TMP/non-auth-retry.err"
test "$(wc -l <"$refresh_log" | tr -d '[:space:]')" = '0'
test "$(wc -l <"$attempt_log" | tr -d '[:space:]')" = '2'
test "$(sed -n '1p' "$attempt_log")" = 'same-auth'
test "$(sed -n '2p' "$attempt_log")" = 'same-auth'
rg -F 'initial signed commit attempt failed; retrying once' "$TMP/non-auth-retry.err" >/dev/null
rg -F 'head oid mismatch' "$TMP/non-auth-retry.err" >/dev/null

if create_api_signed_commit_with_retry '' "$REPO_SLUG" main feature/test 'msg' "$git_auth_basic" >/dev/null 2>"$TMP/retry-args.err"; then
  echo "expected create_api_signed_commit_with_retry to reject missing args" >&2
  exit 1
fi
rg -F 'create_api_signed_commit_with_retry requires repo path, repo slug, base branch, head branch, commit message, and auth' "$TMP/retry-args.err" >/dev/null

AUTO_PR_SIGNED_COMMITS=0
if require_api_signed_commit_mode >/dev/null 2>"$TMP/signed-mode.err"; then
  echo "expected require_api_signed_commit_mode to reject AUTO_PR_SIGNED_COMMITS=0" >&2
  exit 1
fi
rg -F 'AUTO_PR_SIGNED_COMMITS=0 is no longer supported' "$TMP/signed-mode.err" >/dev/null
unset AUTO_PR_SIGNED_COMMITS

IDENTITY_REPO="$TMP/identity-repo"
git init "$IDENTITY_REPO" >/dev/null 2>&1
git -C "$IDENTITY_REPO" config user.name 'wrong bot'
git -C "$IDENTITY_REPO" config user.email 'carapulse@morpho.org'
ensure_repo_git_identity "$IDENTITY_REPO"
test "$(git -C "$IDENTITY_REPO" config user.name)" = 'OpenClaw SRE Bot'
test "$(git -C "$IDENTITY_REPO" config user.email)" = "$READONLY_BOT_EMAIL"

AUTO_PR_GIT_USER_EMAIL='carapulse@morpho.org'
if ensure_repo_git_identity "$IDENTITY_REPO" >/dev/null 2>"$TMP/identity.err"; then
  echo "expected ensure_repo_git_identity to reject non-readonly bot email" >&2
  exit 1
fi
rg -F "AUTO_PR_GIT_USER_EMAIL must be $READONLY_BOT_EMAIL" "$TMP/identity.err" >/dev/null
unset AUTO_PR_GIT_USER_EMAIL

rg -F 'if declare -F refresh_auth_context >/dev/null 2>&1 && refresh_auth_context 1; then' "$TARGET_SCRIPT" >/dev/null
rg -F 'if refresh_auth_context 1; then' "$TARGET_SCRIPT" >/dev/null

rg -F 'AUTO_PR_SIGNED_COMMITS=0 is no longer supported' "$TARGET_SCRIPT" >/dev/null
rg -F 'AUTO_PR_GIT_USER_EMAIL=<email>     (default and enforced: 264278285+prd-carapulse[bot]@users.noreply.github.com)' "$TARGET_SCRIPT" >/dev/null
rg -F "AUTO_PR_READONLY_BOT_EMAIL='264278285+prd-carapulse[bot]@users.noreply.github.com'" "$TARGET_SCRIPT" >/dev/null
rg -F 'ensure_repo_git_identity "$REPO_PATH"' "$TARGET_SCRIPT" >/dev/null
rg -F 'AUTO_PR_GIT_USER_EMAIL must be %s (got %s)\n' "$TARGET_SCRIPT" >/dev/null
if rg -F 'openclaw-sre-bot@morpho.dev' "$TARGET_SCRIPT" >/dev/null; then
  echo "unexpected legacy bot email remains in autofix-pr.sh" >&2
  exit 1
fi
if rg -F 'carapulse@morpho.org' "$TARGET_SCRIPT" >/dev/null; then
  echo "unexpected morpho bot email remains in autofix-pr.sh" >&2
  exit 1
fi
if rg -F 'if [[ -z "$(git -C "$REPO_PATH" config --get user.email || true)" ]]; then' "$TARGET_SCRIPT" >/dev/null; then
  echo "unexpected conditional git email fallback remains in autofix-pr.sh" >&2
  exit 1
fi

if rg -F 'git -C "$REPO_PATH" commit -m "$COMMIT_MSG"' "$TARGET_SCRIPT" >/dev/null; then
  echo "unexpected local git commit fallback remains in autofix-pr.sh" >&2
  exit 1
fi

echo "autofix-pr auth test: PASS"

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

REPO_SLUG="morpho-org/midnight"

resolve_remote_branch_oid() {
  if [[ -n "${MOCK_BRANCH_OID:-}" ]]; then
    printf '%s\n' "$MOCK_BRANCH_OID"
  fi
}

fetch_open_pr_for_head_branch() {
  printf '%s\n' "${MOCK_PR_JSON:-[]}"
}

gh() {
  local path="${2:-}"
  case "$path" in
    "repos/${REPO_SLUG}/commits/${MOCK_BRANCH_OID:-}")
      if [[ -n "${MOCK_COMMIT_JSON:-}" ]]; then
        printf '%s\n' "$MOCK_COMMIT_JSON"
      else
        printf '%s\n' '{}'
      fi
      ;;
    *)
      echo "unexpected gh call: $*" >&2
      return 1
      ;;
  esac
}

unset AUTO_PR_ALLOW_FOREIGN_BRANCH_PUSH
MOCK_BRANCH_OID=""
MOCK_COMMIT_JSON=""
MOCK_PR_JSON="[]"
assert_remote_branch_write_allowed /tmp/repo "$REPO_SLUG" feature/test auth-token

MOCK_BRANCH_OID="abc123"
MOCK_COMMIT_JSON="$(jq -nc --arg email '264278285+prd-carapulse[bot]@users.noreply.github.com' '{commit:{author:{email:$email}}}')"
MOCK_PR_JSON='[]'
assert_remote_branch_write_allowed /tmp/repo "$REPO_SLUG" feature/test auth-token

MOCK_BRANCH_OID="def456"
MOCK_COMMIT_JSON="$(jq -nc --arg email 'adrien@example.com' '{commit:{author:{email:$email}}}')"
MOCK_PR_JSON="$(jq -nc '[{html_url:"https://github.com/morpho-org/midnight/pull/555",user:{login:"adrienh"}}]')"
if assert_remote_branch_write_allowed /tmp/repo "$REPO_SLUG" v2-effects-spec-with-update auth-token >/dev/null 2>"$TMP/foreign-pr.err"; then
  echo "expected assert_remote_branch_write_allowed to reject human-owned PR branch" >&2
  exit 1
fi
rg -F 'auto-pr foreign-branch guard: remote branch v2-effects-spec-with-update already belongs to open PR https://github.com/morpho-org/midnight/pull/555 by adrienh; create a fresh branch or set AUTO_PR_ALLOW_FOREIGN_BRANCH_PUSH=1' "$TMP/foreign-pr.err" >/dev/null

MOCK_BRANCH_OID="def456"
MOCK_COMMIT_JSON="$(jq -nc --arg email 'mathis@example.com' '{commit:{author:{email:$email}}}')"
MOCK_PR_JSON='[]'
if assert_remote_branch_write_allowed /tmp/repo "$REPO_SLUG" feature/existing auth-token >/dev/null 2>"$TMP/foreign-branch.err"; then
  echo "expected assert_remote_branch_write_allowed to reject non-bot branch head" >&2
  exit 1
fi
rg -F 'auto-pr foreign-branch guard: remote branch feature/existing already exists at def456 with non-bot author email mathis@example.com; create a fresh branch or set AUTO_PR_ALLOW_FOREIGN_BRANCH_PUSH=1' "$TMP/foreign-branch.err" >/dev/null

AUTO_PR_ALLOW_FOREIGN_BRANCH_PUSH=1
assert_remote_branch_write_allowed /tmp/repo "$REPO_SLUG" feature/existing auth-token
unset AUTO_PR_ALLOW_FOREIGN_BRANCH_PUSH

echo "autofix-pr branch ownership test: PASS"

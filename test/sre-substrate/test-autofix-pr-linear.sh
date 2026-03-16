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

test "$(strip_pr_title_prefix '[OPENCLAW-SRE] fix(helm): raise replica memory')" = 'fix(helm): raise replica memory'
test "$(strip_pr_title_prefix ' [openclaw-sre]   fix(helm): raise replica memory ')" = 'fix(helm): raise replica memory'
test "$(strip_pr_title_prefix '[OPENCLAW-SRE]')" = ''
test "$(strip_pr_title_prefix 'fix(helm): raise replica memory')" = 'fix(helm): raise replica memory'

test "$(ensure_linear_ticket_in_conventional_title 'fix(helm): raise replica memory' 'PLA-822')" = 'fix(helm:PLA-822): raise replica memory'
test "$(ensure_linear_ticket_in_conventional_title '[OPENCLAW-SRE] fix(helm): raise replica memory' 'PLA-822')" = 'fix(helm:PLA-822): raise replica memory'
test "$(ensure_linear_ticket_in_conventional_title 'fix(helm:PLA-822): raise replica memory' 'PLA-822')" = 'fix(helm:PLA-822): raise replica memory'
test "$(ensure_linear_ticket_in_conventional_title 'fix(helm:pla-822): raise replica memory' 'PLA-822')" = 'fix(helm:pla-822): raise replica memory'
test "$(ensure_linear_ticket_in_conventional_title 'fix: raise replica memory' 'PLA-822')" = 'fix(PLA-822): raise replica memory'
test "$(ensure_linear_ticket_in_conventional_title 'raise replica memory' 'PLA-822')" = 'chore(PLA-822): raise replica memory'
test "$(ensure_linear_ticket_in_conventional_title 'raise replica memory' '')" = 'raise replica memory'
test "$(ensure_linear_ticket_in_conventional_title 'fix(helm): raise replica memory' 'INVALID-REF')" = 'fix(helm): raise replica memory'
test "$(ensure_linear_ticket_in_conventional_title 'fix(helm): raise replica memory' 'PLA-822$(echo nope)')" = 'fix(helm): raise replica memory'
test "$(build_linear_issue_title_from_pr_title '[OPENCLAW-SRE] fix(helm): raise replica memory')" = 'raise replica memory'
test "$(build_linear_issue_title_from_pr_title 'fix: raise replica memory')" = 'raise replica memory'
test "$(build_linear_issue_title_from_pr_title 'raise replica memory')" = 'raise replica memory'
test "$(build_linear_issue_title_from_pr_title '')" = ''

capture_value=''
capture_command_output capture_value printf 'ok'
test "$capture_value" = 'ok'
if capture_command_output 'bad-var' printf 'nope' >/dev/null 2>"$TMP/capture-target.err"; then
  echo "expected invalid capture target variable to fail" >&2
  exit 1
fi
rg -F 'invalid capture target variable: bad-var' "$TMP/capture-target.err" >/dev/null

BODY_FILE="$TMP/body.md"
cat >"$BODY_FILE" <<'EOF'
## Summary
- Raise public replica memory.
EOF

ensure_pr_body_linear_section "$BODY_FILE" "PLA-822" "https://linear.app/morpho-labs/issue/PLA-822/example"
rg -F '## Linear' "$BODY_FILE" >/dev/null
rg -F 'PLA-822: https://linear.app/morpho-labs/issue/PLA-822/example' "$BODY_FILE" >/dev/null

FAKE_LINEAR="$TMP/fake-linear.sh"
FAKE_LOG="$TMP/fake-linear.log"
cat >"$FAKE_LINEAR" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_LOG"
case "$1 $2" in
  'issue create')
    if [[ "${LINEAR_FAIL_CREATE:-0}" == "1" ]]; then
      printf 'create failed\n' >&2
      exit 1
    fi
    if [[ "${LINEAR_BAD_CREATE_JSON:-0}" == "1" ]]; then
      printf '%s\n' '<html>not-json</html>'
      exit 0
    fi
    printf '%s\n' '{"identifier":"PLA-822","url":"https://linear.app/morpho-labs/issue/PLA-822/example?ticket=PLA-822=linked","gitBranchName":"feature/pla-822-replica-memory-fix"}'
    ;;
  'issue get-branch')
    if [[ "${LINEAR_FAIL_BRANCH:-0}" == "1" ]]; then
      printf 'branch failed\n' >&2
      exit 1
    fi
    printf '%s\n' 'feature/pla-822-replica-memory-fix'
    ;;
  'issue add-attachment')
    printf '%s\n' $'attached\tPLA-822\tatt-1'
    ;;
  'issue add-comment')
    printf '%s\n' $'commented\tPLA-822\tcomment-1'
    ;;
  *)
    printf 'unexpected args: %s\n' "$*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$FAKE_LINEAR"

export AUTO_PR_LINEAR_TICKET_API="$FAKE_LINEAR"
export AUTO_PR_LINEAR_STRICT=1
export AUTO_PR_LINEAR_TEAM=Platform
export AUTO_PR_LINEAR_PROJECT='[PLATFORM] Backlog'
export AUTO_PR_LINEAR_ASSIGNEE=florian
export AUTO_PR_LINEAR_STATE='In Progress'
export AUTO_PR_LINEAR_LABELS='openclaw-sre|Bug|Monitoring|Improvement'
export FAKE_LOG

create_output="$(create_linear_issue_for_pr 'raise replica memory' "$BODY_FILE")"
printf '%s\n' "$create_output" | grep -qx 'identifier=PLA-822'
test "$(extract_named_output_value url "$create_output")" = 'https://linear.app/morpho-labs/issue/PLA-822/example?ticket=PLA-822=linked'
printf '%s\n' "$create_output" | grep -qx 'branch=feature/pla-822-replica-memory-fix'
test "$(resolve_linear_issue_branch_name 'PLA-822')" = 'feature/pla-822-replica-memory-fix'

if AUTO_PR_LINEAR_TEAM='Platform$(echo nope)' create_linear_issue_for_pr 'raise replica memory' "$BODY_FILE" >/dev/null 2>"$TMP/invalid-team.err"; then
  echo "expected invalid team value to fail" >&2
  exit 1
fi
rg -F 'invalid AUTO_PR_LINEAR_TEAM value' "$TMP/invalid-team.err" >/dev/null

if AUTO_PR_LINEAR_LABELS='openclaw-sre|bad$(echo nope)' create_linear_issue_for_pr 'raise replica memory' "$BODY_FILE" >/dev/null 2>"$TMP/invalid-label.err"; then
  echo "expected invalid labels value to fail" >&2
  exit 1
fi
rg -F 'invalid AUTO_PR_LINEAR_LABELS value' "$TMP/invalid-label.err" >/dev/null

if LINEAR_FAIL_CREATE=1 create_linear_issue_for_pr 'raise replica memory' "$BODY_FILE" >/dev/null 2>"$TMP/create-strict.err"; then
  echo "expected strict create_linear_issue_for_pr failure" >&2
  exit 1
fi
rg -F 'create failed' "$TMP/create-strict.err" >/dev/null

AUTO_PR_LINEAR_STRICT=0
test -z "$(LINEAR_FAIL_CREATE=1 create_linear_issue_for_pr 'raise replica memory' "$BODY_FILE")"
AUTO_PR_LINEAR_STRICT=1

if parse_linear_create_field '{"identifier":null}' '.identifier // empty' 'identifier' >/dev/null 2>"$TMP/create-empty.err"; then
  echo "expected empty parse_linear_create_field to fail" >&2
  exit 1
fi
rg -F 'failed to parse Linear issue identifier from helper output' "$TMP/create-empty.err" >/dev/null

if LINEAR_BAD_CREATE_JSON=1 create_linear_issue_for_pr 'raise replica memory' "$BODY_FILE" >/dev/null 2>"$TMP/create-json.err"; then
  echo "expected malformed helper output failure" >&2
  exit 1
fi
rg -F 'parse error' "$TMP/create-json.err" >/dev/null
rg -F 'failed to parse Linear issue identifier from helper output' "$TMP/create-json.err" >/dev/null

AUTO_PR_LINEAR_STRICT=0
soft_create_output="$(LINEAR_BAD_CREATE_JSON=1 create_linear_issue_for_pr 'raise replica memory' "$BODY_FILE" 2>"$TMP/create-json-soft.err")"
test -z "$soft_create_output"
rg -F 'parse error' "$TMP/create-json-soft.err" >/dev/null
AUTO_PR_LINEAR_STRICT=1

if LINEAR_FAIL_BRANCH=1 resolve_linear_issue_branch_name 'PLA-822' >/dev/null 2>"$TMP/branch-strict.err"; then
  echo "expected strict resolve_linear_issue_branch_name failure" >&2
  exit 1
fi
rg -F 'branch failed' "$TMP/branch-strict.err" >/dev/null

FAKE_LINEAR_STDERR="$TMP/fake-linear-stderr.sh"
cat >"$FAKE_LINEAR_STDERR" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'rate-limit warning\n' >&2
printf '%s\n' 'feature/pla-822-replica-memory-fix'
EOF
chmod +x "$FAKE_LINEAR_STDERR"
AUTO_PR_LINEAR_TICKET_API="$FAKE_LINEAR_STDERR" test "$(resolve_linear_issue_branch_name 'PLA-822')" = 'feature/pla-822-replica-memory-fix'

AUTO_PR_LINEAR_STRICT=0
test -z "$(LINEAR_FAIL_BRANCH=1 resolve_linear_issue_branch_name 'PLA-822')"
AUTO_PR_LINEAR_STRICT=1

if attach_pr_to_linear_issue '' 'https://github.com/morpho-org/openclaw-sre/pull/123' 'morpho-org/openclaw-sre' 'feature/pla-822-replica-memory-fix' 'fix(helm:PLA-822): raise replica memory' >/dev/null 2>"$TMP/attach-missing.err"; then
  echo "expected strict attachment argument failure" >&2
  exit 1
fi
rg -F 'missing Linear ticket ref or PR URL for PR attachment' "$TMP/attach-missing.err" >/dev/null

attach_pr_to_linear_issue \
  'PLA-822' \
  'https://github.com/morpho-org/openclaw-sre/pull/123' \
  'morpho-org/openclaw-sre' \
  'feature/pla-822-replica-memory-fix' \
  'fix(helm:PLA-822): raise `replica` memory'

rg -F 'issue create --title raise replica memory --file' "$FAKE_LOG" >/dev/null
rg -F 'issue add-attachment PLA-822 https://github.com/morpho-org/openclaw-sre/pull/123 GitHub PR morpho-org/openclaw-sre feature/pla-822-replica-memory-fix' "$FAKE_LOG" >/dev/null
rg -F 'issue add-comment PLA-822 --text Opened remediation PR.' "$FAKE_LOG" >/dev/null
rg -F -- '- Title: fix(helm:PLA-822): raise `replica` memory' "$FAKE_LOG" >/dev/null

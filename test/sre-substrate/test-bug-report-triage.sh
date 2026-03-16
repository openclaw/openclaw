#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/skills/morpho-sre/bug-report-triage.sh"
ROUTING="$REPO_ROOT/skills/morpho-sre/bug-report-routing.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAKE_LINEAR="$TMP/fake-linear.sh"
FAKE_LOG="$TMP/fake-linear.log"

cat >"$FAKE_LINEAR" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${BUG_REPORT_FAKE_LOG:?}"
printf '%s\0' "$@" | jq -Rs 'split("\u0000")[:-1] | { args: . }' >>"$LOG_FILE"

case "${1:-} ${2:-}" in
  "issue create")
    if [[ "${BUG_REPORT_FAKE_CREATE_FAIL:-0}" == "1" ]]; then
      printf 'create failed\n' >&2
      exit 1
    fi
    if [[ "${BUG_REPORT_FAKE_CREATE_BAD_JSON:-0}" == "1" ]]; then
      printf '%s\n' '<html>not-json</html>'
      exit 0
    fi
    printf '%s\n' '{"identifier":"PLA-900","url":"https://linear.app/morpho-labs/issue/PLA-900/example","gitBranchName":"feature/pla-900-example"}'
    ;;
  "issue add-attachment")
    if [[ "${BUG_REPORT_FAKE_ATTACH_FAIL:-0}" == "1" ]]; then
      printf 'attach failed\n' >&2
      exit 1
    fi
    printf 'attached\t%s\tatt-1\n' "${3:-}"
    ;;
  *)
    printf 'unexpected call: %s %s\n' "${1:-}" "${2:-}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$FAKE_LINEAR"

expected_consumer_owner="$(
  jq -r '
    .ownerPools["consumer-app"].current
    // (
      if ((.ownerPools["consumer-app"].rotation // []) | length) > 0
      then .ownerPools["consumer-app"].rotation[0]
      else empty
      end
    )
  ' "$ROUTING"
)"
missing_owner_msg="$(jq -r '.ownerMissingMessage' "$ROUTING")"

consumer_report_file="$TMP/consumer-report.txt"
cat >"$consumer_report_file" <<'EOF'
Title: Can't repay from Safe app
Environment: prod
Source URL: https://app.morpho.org/ethereum/vault/0xabc
Actual result: User gets execution reverted during repay
Expected result: Repay succeeds
EOF
consumer_report_text="$(cat "$consumer_report_file")"

consumer_plan="$(
  printf '%s\n' "$consumer_report_text" \
    | env BUG_REPORT_ROUTING_CONFIG="$ROUTING" "$SCRIPT" plan --stdin
)"

printf '%s\n' "$consumer_plan" | jq -e '.route.id == "consumer-app"' >/dev/null
printf '%s\n' "$consumer_plan" | jq -e --arg owner "$expected_consumer_owner" '.owner.assignee == $owner and .owner.display == $owner' >/dev/null
printf '%s\n' "$consumer_plan" | jq -e '.analysisMode == "deep"' >/dev/null
printf '%s\n' "$consumer_plan" | jq -e '.signals | index("environment:prod") != null' >/dev/null
printf '%s\n' "$consumer_plan" | jq -e '.signals | any(. == "priority:2")' >/dev/null

consumer_plan_without_linear="$(
  printf '%s\n' "$consumer_report_text" \
    | env BUG_REPORT_ROUTING_CONFIG="$ROUTING" BUG_REPORT_LINEAR_API="../missing-linear.sh" "$SCRIPT" plan --stdin
)"
printf '%s\n' "$consumer_plan_without_linear" | jq -e '.route.id == "consumer-app"' >/dev/null

consumer_issue="$(
  env \
    BUG_REPORT_ROUTING_CONFIG="$ROUTING" \
    BUG_REPORT_LINEAR_API="$FAKE_LINEAR" \
    BUG_REPORT_FAKE_LOG="$FAKE_LOG" \
    "$SCRIPT" create-issue \
    --thread-url "https://morpholabs.slack.com/archives/C123/p1773576730195609" \
    --text "$consumer_report_text"
)"

printf '%s\n' "$consumer_issue" | jq -e '.issue.identifier == "PLA-900"' >/dev/null
printf '%s\n' "$consumer_issue" | jq -e '.threadAttachment.attached == true' >/dev/null
printf '%s\n' "$consumer_issue" | jq -e --arg owner "$expected_consumer_owner" '.owner.assignee == $owner' >/dev/null

jq -e '
  select(.args[0] == "issue" and .args[1] == "create")
  | (.args | index("--assignee")) as $assignee_idx
  | ($assignee_idx != null)
  and .args[$assignee_idx + 1] != ""
  and (.args | index("--labels")) != null
' "$FAKE_LOG" >/dev/null

jq -e '
  select(.args[0] == "issue" and .args[1] == "add-attachment")
  | .args[3] == "https://morpholabs.slack.com/archives/C123/p1773576730195609"
' "$FAKE_LOG" >/dev/null

consumer_issue_attach_warn="$(
  env \
    BUG_REPORT_ROUTING_CONFIG="$ROUTING" \
    BUG_REPORT_LINEAR_API="$FAKE_LINEAR" \
    BUG_REPORT_FAKE_LOG="$FAKE_LOG" \
    BUG_REPORT_FAKE_ATTACH_FAIL=1 \
    "$SCRIPT" create-issue \
    --thread-url "https://morpholabs.slack.com/archives/C123/p1773576730195609" \
    --text "$consumer_report_text" 2>"$TMP/attach-warn.err"
)"

printf '%s\n' "$consumer_issue_attach_warn" | jq -e '.issue.identifier == "PLA-900"' >/dev/null
printf '%s\n' "$consumer_issue_attach_warn" | jq -e '.threadAttachment.attached == false' >/dev/null
rg -F 'warning: failed to attach Slack thread for PLA-900 (issue already created)' "$TMP/attach-warn.err" >/dev/null
rg -F 'attach failed' "$TMP/attach-warn.err" >/dev/null

generic_report="$TMP/generic-report.txt"
cat >"$generic_report" <<'EOF'
Title: Docs typo on FAQ page
Environment: prod
Actual result: Page says reapy instead of repay
Expected result: Spelling should be correct
EOF

generic_issue="$(
  env \
    BUG_REPORT_ROUTING_CONFIG="$ROUTING" \
    BUG_REPORT_LINEAR_API="$FAKE_LINEAR" \
    BUG_REPORT_FAKE_LOG="$FAKE_LOG" \
    "$SCRIPT" create-issue --file "$generic_report"
)"

printf '%s\n' "$generic_issue" | jq -e --arg msg "$missing_owner_msg" '.owner.display == $msg and .owner.assignee == null' >/dev/null
printf '%s\n' "$generic_issue" | jq -e '.route.id == "general-bug"' >/dev/null
printf '%s\n' "$generic_issue" | jq -e '.route.labels | index("manual-review") != null' >/dev/null

jq -s -e '
  ([ .[] | select(.args[0] == "issue" and .args[1] == "create") | .args ] | length) >= 3
  and
  ([ .[] | select(.args[0] == "issue" and .args[1] == "create" and (.args | index("--assignee") == null)) ] | length) >= 1
' "$FAKE_LOG" >/dev/null

mkdir -p "$TMP/inner"
cp "$generic_report" "$TMP/report.txt"
if (
  cd "$TMP/inner" &&
  env BUG_REPORT_ROUTING_CONFIG="$ROUTING" "$SCRIPT" plan --file ../report.txt >/dev/null
) 2>"$TMP/parent-path.err"; then
  echo "expected parent-relative file path to fail" >&2
  exit 1
fi
rg -F 'parent-relative file paths are not allowed' "$TMP/parent-path.err" >/dev/null

if env BUG_REPORT_ROUTING_CONFIG="../missing-routing.json" "$SCRIPT" plan --text "$consumer_report_text" >/dev/null 2>"$TMP/invalid-routing.err"; then
  echo "expected invalid routing-config path to fail" >&2
  exit 1
fi
rg -F 'parent-relative file paths are not allowed' "$TMP/invalid-routing.err" >/dev/null

if env BUG_REPORT_ROUTING_CONFIG="$ROUTING" BUG_REPORT_LINEAR_API="$FAKE_LINEAR" BUG_REPORT_FAKE_LOG="$FAKE_LOG" BUG_REPORT_FAKE_CREATE_FAIL=1 "$SCRIPT" create-issue --text "$consumer_report_text" >/dev/null 2>"$TMP/create-fail.err"; then
  echo "expected issue create failure to fail" >&2
  exit 1
fi
rg -F 'create failed' "$TMP/create-fail.err" >/dev/null
rg -F 'issue create failed' "$TMP/create-fail.err" >/dev/null

if env BUG_REPORT_ROUTING_CONFIG="$ROUTING" BUG_REPORT_LINEAR_API="$FAKE_LINEAR" BUG_REPORT_FAKE_LOG="$FAKE_LOG" BUG_REPORT_FAKE_CREATE_BAD_JSON=1 "$SCRIPT" create-issue --text "$consumer_report_text" >/dev/null 2>"$TMP/create-json.err"; then
  echo "expected invalid issue JSON to fail" >&2
  exit 1
fi
rg -F 'issue create returned invalid JSON' "$TMP/create-json.err" >/dev/null
rg -F '<html>not-json</html>' "$TMP/create-json.err" >/dev/null

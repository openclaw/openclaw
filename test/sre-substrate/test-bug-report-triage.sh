#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/skills/morpho-sre/bug-report-triage.sh"
ROUTING="$REPO_ROOT/skills/morpho-sre/bug-report-routing.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAKE_LINEAR="$TMP/fake-linear.sh"
FAKE_LOG="$TMP/fake-linear.log"
FAKE_RESOLVER="$TMP/fake-resolver.sh"
FAKE_RESOLVER_LOG="$TMP/fake-resolver.log"

cat >"$FAKE_LINEAR" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${BUG_REPORT_FAKE_LOG:?}"
printf '%s\0' "$@" | jq -Rs 'split("\u0000") | if .[-1] == "" then .[:-1] else . end | { args: . }' >>"$LOG_FILE"

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
    printf '%s\n' '{"identifier":"PLA-900","url":"https://linear.app/morpho-labs/issue/PLA-900/example","branchName":"feature/pla-900-example"}'
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

cat >"$FAKE_RESOLVER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${BUG_REPORT_FAKE_RESOLVER_LOG:?}"
stdin_text="$(cat)"
jq -nc --arg env "${1:-}" --arg stdin "$stdin_text" --arg extra "${2:-}" \
  '{ env: $env, stdin: $stdin, extra: $extra }' >>"$LOG_FILE"
jq -nc '{ posthog: { top: null }, sentry: { top: null } }'
EOF
chmod +x "$FAKE_RESOLVER"

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
printf '%s\n' "$consumer_plan" | jq -e '.fixGate.ready == true and (.fixGate.blockers | length == 0) and (.fixGate.requiredBlockers | length == 0) and (.fixGate.advisories | length == 2)' >/dev/null

consumer_plan_without_linear="$(
  printf '%s\n' "$consumer_report_text" \
    | env BUG_REPORT_ROUTING_CONFIG="$ROUTING" BUG_REPORT_LINEAR_API="../missing-linear.sh" "$SCRIPT" plan --stdin
)"
printf '%s\n' "$consumer_plan_without_linear" | jq -e '.route.id == "consumer-app"' >/dev/null

curator_report_text=$'Title: Increase timelock action shows as decrease timelock action\nEnvironment: prod\nSource URL: https://curator-v2-app.vercel.app/ethereum/vault/0xdeadbeef\nActual result: Pending action shows decrease timelock to 1 even though the latest action should be increase timelock to 3\nExpected result: Latest pending action should show increase timelock to 3\nCorrection: This is not a UI problem unless chronology replay disproves the old pending action theory'

curator_plan="$(
  printf '%s\n' "$curator_report_text" \
    | env BUG_REPORT_ROUTING_CONFIG="$ROUTING" "$SCRIPT" plan --stdin
)"

printf '%s\n' "$curator_plan" | jq -e '.route.id == "curator-frontend" and .route.team == "CRTR"' >/dev/null
printf '%s\n' "$curator_plan" | jq -e '.preflight.appHint == "curator-v2-app" and .preflight.repoHint == "morpho-org/prime-monorepo"' >/dev/null
printf '%s\n' "$curator_plan" | jq -e '.preflight.chronologyCheckRequired == true' >/dev/null
printf '%s\n' "$curator_plan" | jq -e '.fixGate.ready == false' >/dev/null
printf '%s\n' "$curator_plan" | jq -e '.fixGate.blockers | index("Replay state/history chronology before naming a UI-label or stale-state cause.") != null' >/dev/null
printf '%s\n' "$curator_plan" | jq -e '.signals | index("chronology:required") != null' >/dev/null
printf '%s\n' "$curator_plan" | jq -e '.next | contains("Replay exact artifact and state/history chronology before code blame.")' >/dev/null

mixed_case_curator_report_text=$'Title: Increase timelock Action Shows As decrease timelock action\nEnvironment: prod\nSource URL: https://curator-v2-app.vercel.app/ethereum/vault/0xdeadbeef\nActual result: Pending action Shows As decrease timelock to 1 Instead Of increase timelock to 3\nExpected result: Latest pending action should show increase timelock to 3'
mixed_case_curator_plan="$(
  printf '%s\n' "$mixed_case_curator_report_text" \
    | env BUG_REPORT_ROUTING_CONFIG="$ROUTING" "$SCRIPT" plan --stdin
)"
printf '%s\n' "$mixed_case_curator_plan" | jq -e '.preflight.chronologyCheckRequired == true' >/dev/null

generic_history_report_text=$'Title: History tab typo\nActual result: History tab label is reapy\nExpected result: History tab should say repay'
generic_history_plan="$(
  printf '%s\n' "$generic_history_report_text" \
    | env BUG_REPORT_ROUTING_CONFIG="$ROUTING" "$SCRIPT" plan --stdin
)"
printf '%s\n' "$generic_history_plan" | jq -e '.preflight.chronologyCheckRequired == false' >/dev/null

latest_correction_report_text=$'Title: Pending action mismatch\nActual result: Pending action shows decrease timelock to 1\nExpected result: Latest pending action should show increase timelock to 3\nThis is wrong, old note\nThe bug is the latest pending action chronology'
latest_correction_plan="$(
  printf '%s\n' "$latest_correction_report_text" \
    | env BUG_REPORT_ROUTING_CONFIG="$ROUTING" "$SCRIPT" plan --stdin
)"
printf '%s\n' "$latest_correction_plan" | jq -e '.preflight.latestHumanCorrection == "The bug is the latest pending action chronology"' >/dev/null

non_correction_report_text=$'Title: Pending action mismatch\nActual result: Pending action shows decrease timelock to 1\nExpected result: Latest pending action should show increase timelock to 3\nThis is not ready for production yet.'
non_correction_plan="$(
  printf '%s\n' "$non_correction_report_text" \
    | env BUG_REPORT_ROUTING_CONFIG="$ROUTING" "$SCRIPT" plan --stdin
)"
printf '%s\n' "$non_correction_plan" | jq -e '.preflight.latestHumanCorrection == null' >/dev/null

resolver_prompt_report=$'Title: Wallet connect resolver prompt handoff\nEnvironment: prod\nSource URL: https://app.morpho.org/ethereum/vault/0xbeef\nActual result: Wallet connect report keeps shell metacharacters $(echo nope) literal\nExpected result: Resolver should read the full report from stdin only'
resolver_prompt_plan="$(
  printf '%s\n' "$resolver_prompt_report" \
    | env \
        BUG_REPORT_ROUTING_CONFIG="$ROUTING" \
        BUG_REPORT_FRONTEND_RESOLVER="$FAKE_RESOLVER" \
        BUG_REPORT_FAKE_RESOLVER_LOG="$FAKE_RESOLVER_LOG" \
        "$SCRIPT" plan --stdin
)"
printf '%s\n' "$resolver_prompt_plan" | jq -e '.report.actualResult == "Wallet connect report keeps shell metacharacters $(echo nope) literal"' >/dev/null
printf '%s\n' "$resolver_prompt_plan" | jq -e '.route.id == "consumer-app"' >/dev/null
jq -se '
  length == 1
  and .[0].env == "prd"
  and .[0].extra == ""
  and (.[0].stdin | contains("Wallet connect report keeps shell metacharacters $(echo nope) literal"))
' "$FAKE_RESOLVER_LOG" >/dev/null

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
printf '%s\n' "$consumer_issue" | jq -e '.issue.branchName == "feature/pla-900-example" and .issue.gitBranchName == "feature/pla-900-example"' >/dev/null
printf '%s\n' "$consumer_issue" | jq -e --arg owner "$expected_consumer_owner" '.owner.assignee == $owner' >/dev/null

jq -se '
  map(
    select(.["args"][0] == "issue" and .["args"][1] == "create")
    | (.args | index("--assignee")) as $assignee_idx
    | ($assignee_idx != null)
      and .args[$assignee_idx + 1] != ""
      and (.args | index("--labels")) != null
  ) | any
' "$FAKE_LOG" >/dev/null

jq -se '
  map(
    select(.["args"][0] == "issue" and .["args"][1] == "add-attachment")
    | .args[3] == "https://morpholabs.slack.com/archives/C123/p1773576730195609"
  ) | any
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

curator_issue="$(
  env \
    BUG_REPORT_ROUTING_CONFIG="$ROUTING" \
    BUG_REPORT_LINEAR_API="$FAKE_LINEAR" \
    BUG_REPORT_FAKE_LOG="$FAKE_LOG" \
    "$SCRIPT" create-issue --text "$curator_report_text"
)"

printf '%s\n' "$curator_issue" | jq -e '.route.id == "curator-frontend" and .preflight.chronologyCheckRequired == true' >/dev/null
printf '%s\n' "$curator_issue" | jq -e '.fixGate.ready == false' >/dev/null

jq -se '
  map(
    select(.args[0] == "issue" and .args[1] == "create")
    | (.args | index("--team")) as $team_idx
    | $team_idx != null and .args[$team_idx + 1] == "CRTR"
  ) | any
' "$FAKE_LOG" >/dev/null

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

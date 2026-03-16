#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/skills/morpho-sre/linear-ticket-api.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PARTIAL_SCRIPT="$TMP/linear-ticket-api.partial.sh"
END_LINE="$(grep -n '^main() {' "$SCRIPT" | head -1 | cut -d: -f1)"
test -n "$END_LINE"
sed -n "1,$((END_LINE - 1))p" "$SCRIPT" >"$PARTIAL_SCRIPT"

# shellcheck source=/dev/null
source "$PARTIAL_SCRIPT"

FAKE_CURL="$TMP/fake-curl.sh"
cat >"$FAKE_CURL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

payload=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --data)
      payload="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

query="$(printf '%s\n' "$payload" | jq -r '.query')"
name_var="$(printf '%s\n' "$payload" | jq -r '.variables.name // empty')"
issue_ref_var="$(printf '%s\n' "$payload" | jq -r '.variables.id // empty')"

case "$query" in
  *'query { viewer { id name email } }'*)
    printf '%s\n' '{"data":{"viewer":{"id":"123e4567-e89b-12d3-a456-426614174000","name":"Test User","email":"test@example.com"}}}'
    ;;
  *'query { viewer { id } }'*)
    if [[ "${LINEAR_FAKE_EMPTY_VIEWER:-0}" == "1" ]]; then
      printf '%s\n' '{"data":{"viewer":{"id":""}}}'
    elif [[ "${LINEAR_FAKE_INVALID_VIEWER:-0}" == "1" ]]; then
      printf '%s\n' '{"data":{"viewer":{"id":"user-1"}}}'
    else
      printf '%s\n' '{"data":{"viewer":{"id":"123e4567-e89b-12d3-a456-426614174000"}}}'
    fi
    ;;
  *'teams(filter:'*)
    printf '%s\n' '{"data":{"teams":{"nodes":[{"id":"team-1","name":"Platform"}]}}}'
    ;;
  *'projects(filter:'*)
    printf '%s\n' '{"data":{"projects":{"nodes":[{"id":"project-1","name":"[PLATFORM] Backlog"}]}}}'
    ;;
  *'workflowStates(filter:'*)
    printf '%s\n' '{"data":{"workflowStates":{"nodes":[{"id":"state-1","name":"In Progress"}]}}}'
    ;;
  *'issueLabels(filter:'*)
    if [[ "$name_var" == "new-label" ]]; then
      printf '%s\n' '{"data":{"issueLabels":{"nodes":[]}}}'
    else
      printf '%s\n' '{"data":{"issueLabels":{"nodes":[{"id":"label-1","name":"openclaw-sre"}]}}}'
    fi
    ;;
  *'issueLabelCreate(input:'*)
    printf '%s\n' '{"data":{"issueLabelCreate":{"success":true,"issueLabel":{"id":"label-2","name":"new-label"}}}}'
    ;;
  *'issueCreate(input:'*)
    printf '%s\n' '{"data":{"issueCreate":{"success":true,"issue":{"id":"issue-1","identifier":"PLA-822","title":"Replica memory fix","url":"https://linear.app/morpho-labs/issue/PLA-822/example","gitBranchName":"feature/pla-822-replica-memory-fix"}}}}'
    ;;
  *'issue(id:$id)'*)
    if [[ "$issue_ref_var" == "PLA-404" ]]; then
      printf '%s\n' '{"data":{"issue":null}}'
    elif [[ "${LINEAR_FAKE_EMPTY_BRANCH:-0}" == "1" ]]; then
      printf '%s\n' '{"data":{"issue":{"id":"issue-1","identifier":"PLA-822","title":"Replica memory fix","description":"desc","url":"https://linear.app/morpho-labs/issue/PLA-822/example","gitBranchName":"","state":{"id":"state-1","name":"In Progress"},"labels":{"nodes":[{"id":"label-1","name":"openclaw-sre"}]}}}}'
    else
      printf '%s\n' '{"data":{"issue":{"id":"issue-1","identifier":"PLA-822","title":"Replica memory fix","description":"desc","url":"https://linear.app/morpho-labs/issue/PLA-822/example","gitBranchName":"feature/pla-822-replica-memory-fix","state":{"id":"state-1","name":"In Progress"},"labels":{"nodes":[{"id":"label-1","name":"openclaw-sre"}]}}}}'
    fi
    ;;
  *'attachmentCreate(input:'*)
    printf '%s\n' '{"data":{"attachmentCreate":{"success":true,"attachment":{"id":"att-1","url":"https://github.com/morpho-org/openclaw-sre/pull/123"}}}}'
    ;;
  *)
    printf 'unexpected query: %s\n' "$query" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$FAKE_CURL"

export LINEAR_API_KEY=dummy
# Keep all CLI calls below hermetic: the script shells through this fake curl.
export LINEAR_CURL_BIN="$FAKE_CURL"

test "$(normalize_priority_value urgent)" = '1'
test "$(normalize_priority_value major)" = '2'
test "$(normalize_priority_value normal)" = '3'
test "$(normalize_priority_value cosmetic)" = '4'
test "$(normalize_priority_value none)" = '0'

is_uuid_like '123e4567-e89b-12d3-a456-426614174000'
! is_uuid_like 'not-a-uuid'
! is_uuid_like '1234567890abcdef1234567890abcdef'

labels_json="$(parse_label_refs_json 'openclaw-sre|123e4567-e89b-12d3-a456-426614174000|openclaw-sre,new-label,new-label')"
printf '%s\n' "$labels_json" \
  | jq -e '. == ["label-1","123e4567-e89b-12d3-a456-426614174000","label-2"]' >/dev/null

create_json="$(
  bash "$SCRIPT" issue create \
    --title "Replica memory fix" \
    --text "desc" \
    --team Platform \
    --project "[PLATFORM] Backlog" \
    --assignee me \
    --state "In Progress" \
    --labels "openclaw-sre"
)"

printf '%s\n' "$create_json" \
  | jq -e '.identifier == "PLA-822" and .gitBranchName == "feature/pla-822-replica-memory-fix"' >/dev/null

probe_output="$(bash "$SCRIPT" probe-auth)"
printf '%s\n' "$probe_output" | jq -e '.ok == true' >/dev/null
printf '%s\n' "$probe_output" | jq -e '.viewerId == "123e4567-e89b-12d3-a456-426614174000"' >/dev/null
printf '%s\n' "$probe_output" | jq -e '.viewerName == "Test User"' >/dev/null
printf '%s\n' "$probe_output" | jq -e '.viewerEmail == "test@example.com"' >/dev/null

branch_name="$(
  bash "$SCRIPT" issue get-branch PLA-822
)"
test "$branch_name" = 'feature/pla-822-replica-memory-fix'

if bash "$SCRIPT" issue get-branch PLA-404 >/dev/null 2>"$TMP/branch-missing.err"; then
  echo "expected missing issue get-branch to fail" >&2
  exit 1
fi
rg -F 'issue not found: PLA-404' "$TMP/branch-missing.err" >/dev/null

if LINEAR_FAKE_EMPTY_BRANCH=1 bash "$SCRIPT" issue get-branch PLA-822 >/dev/null 2>"$TMP/branch-empty.err"; then
  echo "expected empty branch get-branch to fail" >&2
  exit 1
fi
rg -F 'issue missing gitBranchName: PLA-822' "$TMP/branch-empty.err" >/dev/null

issue_json="$(
  bash "$SCRIPT" issue get PLA-822
)"
printf '%s\n' "$issue_json" \
  | jq -e '.identifier == "PLA-822" and .url == "https://linear.app/morpho-labs/issue/PLA-822/example"' >/dev/null

attachment_out="$(
  bash "$SCRIPT" issue add-attachment PLA-822 https://github.com/morpho-org/openclaw-sre/pull/123 "GitHub PR" "repo branch"
)"
printf '%s\n' "$attachment_out" | grep -qx $'attached\tPLA-822\tatt-1'

EMPTY_VIEWER_OUT="$TMP/linear-ticket-api-empty-viewer.out"
EMPTY_VIEWER_ERR="$TMP/linear-ticket-api-empty-viewer.err"
if LINEAR_FAKE_EMPTY_VIEWER=1 \
  bash "$SCRIPT" issue create \
    --title "Replica memory fix" \
    --text "desc" \
    --team Platform \
    --project "[PLATFORM] Backlog" \
    --assignee me \
    --state "In Progress" \
    --labels "openclaw-sre" >"$EMPTY_VIEWER_OUT" 2>"$EMPTY_VIEWER_ERR"; then
  echo "expected empty viewer-id create to fail" >&2
  exit 1
fi
rg -F 'viewer query returned empty id - check Linear API authentication' "$EMPTY_VIEWER_ERR" >/dev/null

INVALID_VIEWER_OUT="$TMP/linear-ticket-api-invalid-viewer.out"
INVALID_VIEWER_ERR="$TMP/linear-ticket-api-invalid-viewer.err"
if LINEAR_FAKE_INVALID_VIEWER=1 \
  bash "$SCRIPT" issue create \
    --title "Replica memory fix" \
    --text "desc" \
    --team Platform \
    --project "[PLATFORM] Backlog" \
    --assignee me \
    --state "In Progress" \
    --labels "openclaw-sre" >"$INVALID_VIEWER_OUT" 2>"$INVALID_VIEWER_ERR"; then
  echo "expected invalid viewer-id create to fail" >&2
  exit 1
fi
rg -F 'viewer query returned invalid id - check Linear API authentication' "$INVALID_VIEWER_ERR" >/dev/null

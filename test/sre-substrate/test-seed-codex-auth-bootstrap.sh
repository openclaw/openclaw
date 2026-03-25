#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# Scenario matrix:
# - valid auth bootstrap
# - CODEX_AUTH_JSON unset
# - CODEX_AUTH_JSON empty
# - malformed JSON
# - schema-invalid JSON
# - minimal valid JSON
# - overwrite / idempotency

setup_runtime_repo() {
  local runtime_repo="$1"
  local skill_root="$runtime_repo/skills/morpho-sre"

  mkdir -p "$skill_root/config" "$skill_root/references" "$skill_root/evidence-manifests"
  for bundled_skill in \
    argocd-diff \
    eks-troubleshoot \
    foundry-evm-debug \
    grafana-metrics-best-practices \
    go-memory-profiling \
    terraform-ci-review \
    vercel \
    sre-incident-triage \
    sre-db-evidence \
    sre-api-wrappers \
    sre-auto-remediation \
    sre-consumer-frontend \
    sre-sentinel \
    sre-verify; do
    mkdir -p "$runtime_repo/skills/$bundled_skill"
    cp -R "$REPO_ROOT/skills/$bundled_skill/." "$runtime_repo/skills/$bundled_skill/"
  done

  cp "$REPO_ROOT/skills/morpho-sre/SKILL.md" "$skill_root/SKILL.md"
  cp "$REPO_ROOT/skills/morpho-sre/HEARTBEAT.md" "$skill_root/HEARTBEAT.md"
  cp "$REPO_ROOT/skills/morpho-sre/config/openclaw.json" "$skill_root/config/openclaw.json"
  cp "$REPO_ROOT/skills/morpho-sre/sentinel-triage.sh" "$skill_root/sentinel-triage.sh"
  cp "$REPO_ROOT/skills/morpho-sre/repo-ownership.json" "$skill_root/repo-ownership.json"
  cp "$REPO_ROOT/skills/morpho-sre/knowledge-index.md" "$skill_root/knowledge-index.md"
  cp -R "$REPO_ROOT/skills/morpho-sre/references/." "$skill_root/references/"
  cp -R "$REPO_ROOT/skills/morpho-sre/evidence-manifests/." "$skill_root/evidence-manifests/"
}

run_seed_state() {
  local runtime_repo="$1"
  local state_dir="$2"
  local auth_mode="${3:-unset}"
  local codex_auth_json="${4-}"

  local stdout_file stderr_file
  stdout_file="$TMP_ROOT/stdout-$(basename "$state_dir").log"
  stderr_file="$TMP_ROOT/stderr-$(basename "$state_dir").log"

  case "$auth_mode" in
    set)
      OPENCLAW_SRE_RUNTIME_REPO_DIR="$runtime_repo" \
      OPENCLAW_STATE_DIR="$state_dir" \
      OPENCLAW_CONFIG_PATH="$state_dir/openclaw.json" \
      CODEX_AUTH_JSON="$codex_auth_json" \
      bash "$REPO_ROOT/scripts/sre-runtime/seed-state.sh" \
        >"$stdout_file" 2>"$stderr_file"
      ;;
    empty)
      OPENCLAW_SRE_RUNTIME_REPO_DIR="$runtime_repo" \
      OPENCLAW_STATE_DIR="$state_dir" \
      OPENCLAW_CONFIG_PATH="$state_dir/openclaw.json" \
      CODEX_AUTH_JSON="" \
      bash "$REPO_ROOT/scripts/sre-runtime/seed-state.sh" \
        >"$stdout_file" 2>"$stderr_file"
      ;;
    unset)
      OPENCLAW_SRE_RUNTIME_REPO_DIR="$runtime_repo" \
      OPENCLAW_STATE_DIR="$state_dir" \
      OPENCLAW_CONFIG_PATH="$state_dir/openclaw.json" \
      bash "$REPO_ROOT/scripts/sre-runtime/seed-state.sh" \
        >"$stdout_file" 2>"$stderr_file"
      ;;
    *)
      echo "unknown auth mode: $auth_mode" >&2
      exit 1
      ;;
  esac
}

seed_stale_auth_file() {
  local auth_file="$1"
  mkdir -p "$(dirname "$auth_file")"
  printf '%s\n' "$STALE_AUTH_JSON" >"$auth_file"
}

assert_stale_auth_cleared() {
  local state_name="$1"
  local auth_file="$2"
  rg -F 'auth-bootstrap:clearing-stale-auth-file' "$TMP_ROOT/stderr-${state_name}.log" >/dev/null
  test ! -f "$auth_file"
}

get_file_mode() {
  local target="$1"
  # Try BSD stat first (macOS), then GNU stat (Linux CI).
  if stat -f '%Lp' "$target" >/dev/null 2>&1; then
    stat -f '%Lp' "$target"
    return 0
  fi
  if stat -c '%a' "$target" >/dev/null 2>&1; then
    stat -c '%a' "$target"
    return 0
  fi
  echo "ERROR: Unable to determine file mode on this platform" >&2
  return 1
}

RUNTIME_REPO="$TMP_ROOT/runtime/openclaw-sre"
STATE_DIR="$TMP_ROOT/state"
AUTH_FILE="$STATE_DIR/agents/main/agent/auth-profiles.json"
STALE_AUTH_JSON='{"version":1,"profiles":{"openai-codex:default":{"type":"oauth","provider":"openai-codex","accountId":"stale"}}}'
setup_runtime_repo "$RUNTIME_REPO"

echo '--- scenario: valid auth bootstrap ---'
VALID_CODEX_AUTH_JSON='{"version":1,"profiles":{"openai-codex:default":{"type":"oauth","provider":"openai-codex","access":"header.payload.sig","refresh":"refresh-token","expires":1774266149122,"accountId":"acct-123"}}}'
run_seed_state "$RUNTIME_REPO" "$STATE_DIR" set "$VALID_CODEX_AUTH_JSON"

rg -F 'auth-bootstrap:codex-auth-json' "$TMP_ROOT/stdout-state.log" >/dev/null
test -f "$AUTH_FILE"
test "$(get_file_mode "$AUTH_FILE")" = "600"
jq -e '
  .version == 1 and
  .profiles["openai-codex:default"].provider == "openai-codex" and
  .profiles["openai-codex:default"].accountId == "acct-123"
' "$AUTH_FILE" >/dev/null

echo '--- scenario: CODEX_AUTH_JSON unset ---'
UNSET_STATE_DIR="$TMP_ROOT/state-unset"
UNSET_AUTH_FILE="$UNSET_STATE_DIR/agents/main/agent/auth-profiles.json"
seed_stale_auth_file "$UNSET_AUTH_FILE"
run_seed_state "$RUNTIME_REPO" "$UNSET_STATE_DIR" unset
rg -F 'auth-bootstrap:skipped (no CODEX_AUTH_JSON)' "$TMP_ROOT/stdout-state-unset.log" >/dev/null
assert_stale_auth_cleared "state-unset" "$UNSET_AUTH_FILE"
test ! -d "$(dirname "$UNSET_AUTH_FILE")"

echo '--- scenario: CODEX_AUTH_JSON empty ---'
EMPTY_STATE_DIR="$TMP_ROOT/state-empty"
EMPTY_AUTH_FILE="$EMPTY_STATE_DIR/agents/main/agent/auth-profiles.json"
seed_stale_auth_file "$EMPTY_AUTH_FILE"
run_seed_state "$RUNTIME_REPO" "$EMPTY_STATE_DIR" empty
rg -F 'auth-bootstrap:skipped (no CODEX_AUTH_JSON)' "$TMP_ROOT/stdout-state-empty.log" >/dev/null
assert_stale_auth_cleared "state-empty" "$EMPTY_AUTH_FILE"
test ! -d "$(dirname "$EMPTY_AUTH_FILE")"

echo '--- scenario: malformed JSON ---'
INVALID_STATE_DIR="$TMP_ROOT/state-invalid"
INVALID_AUTH_FILE="$INVALID_STATE_DIR/agents/main/agent/auth-profiles.json"
seed_stale_auth_file "$INVALID_AUTH_FILE"
original_invalid_content="$(cat "$INVALID_AUTH_FILE")"
test "$original_invalid_content" = "$STALE_AUTH_JSON"
if run_seed_state "$RUNTIME_REPO" "$INVALID_STATE_DIR" set '{"version":1,"profiles":' ; then
  echo "expected invalid CODEX_AUTH_JSON to fail" >&2
  exit 1
fi
rg -F 'auth-bootstrap:invalid-codex-auth-json: malformed JSON' "$TMP_ROOT/stderr-state-invalid.log" >/dev/null
assert_stale_auth_cleared "state-invalid" "$INVALID_AUTH_FILE"

echo '--- scenario: schema-invalid JSON ---'
SCHEMA_INVALID_STATE_DIR="$TMP_ROOT/state-schema-invalid"
SCHEMA_INVALID_AUTH_FILE="$SCHEMA_INVALID_STATE_DIR/agents/main/agent/auth-profiles.json"
seed_stale_auth_file "$SCHEMA_INVALID_AUTH_FILE"
if run_seed_state "$RUNTIME_REPO" "$SCHEMA_INVALID_STATE_DIR" set '{"foo":"bar"}' ; then
  echo "expected schema-invalid CODEX_AUTH_JSON to fail" >&2
  exit 1
fi
rg -F 'auth-bootstrap:invalid-codex-auth-json: schema-mismatch' "$TMP_ROOT/stderr-state-schema-invalid.log" >/dev/null
assert_stale_auth_cleared "state-schema-invalid" "$SCHEMA_INVALID_AUTH_FILE"

echo '--- scenario: invalid profile entry ---'
BAD_PROFILE_STATE_DIR="$TMP_ROOT/state-bad-profile"
BAD_PROFILE_AUTH_FILE="$BAD_PROFILE_STATE_DIR/agents/main/agent/auth-profiles.json"
seed_stale_auth_file "$BAD_PROFILE_AUTH_FILE"
if run_seed_state "$RUNTIME_REPO" "$BAD_PROFILE_STATE_DIR" set '{"version":"1","profiles":{"test":{"provider":"","mode":"bogus"}}}' ; then
  echo "expected invalid profile entry to fail" >&2
  exit 1
fi
rg -F 'auth-bootstrap:invalid-codex-auth-json: schema-mismatch' "$TMP_ROOT/stderr-state-bad-profile.log" >/dev/null
assert_stale_auth_cleared "state-bad-profile" "$BAD_PROFILE_AUTH_FILE"

echo '--- scenario: minimal valid JSON ---'
MINIMAL_STATE_DIR="$TMP_ROOT/state-minimal"
MINIMAL_AUTH_FILE="$MINIMAL_STATE_DIR/agents/main/agent/auth-profiles.json"
MINIMAL_CODEX_AUTH_JSON='{"version":1,"profiles":{"test":{"provider":"openai-codex","type":"oauth"}}}'
run_seed_state "$RUNTIME_REPO" "$MINIMAL_STATE_DIR" set "$MINIMAL_CODEX_AUTH_JSON"
test -f "$MINIMAL_AUTH_FILE"
test "$(get_file_mode "$MINIMAL_AUTH_FILE")" = "600"
jq -e '.profiles.test.provider == "openai-codex" and .profiles.test.type == "oauth"' "$MINIMAL_AUTH_FILE" >/dev/null

echo '--- scenario: loader-compatible aliases ---'
COMPAT_STATE_DIR="$TMP_ROOT/state-compat"
COMPAT_AUTH_FILE="$COMPAT_STATE_DIR/agents/main/agent/auth-profiles.json"
COMPAT_CODEX_AUTH_JSON='{"version":"1","profiles":{"test":{"provider":"openai-codex","mode":"oauth"}}}'
run_seed_state "$RUNTIME_REPO" "$COMPAT_STATE_DIR" set "$COMPAT_CODEX_AUTH_JSON"
test -f "$COMPAT_AUTH_FILE"
jq -e '.version == "1" and .profiles.test.mode == "oauth"' "$COMPAT_AUTH_FILE" >/dev/null

echo '--- scenario: overwrite / idempotency ---'
OVERWRITE_STATE_DIR="$TMP_ROOT/state-overwrite"
OVERWRITE_AUTH_FILE="$OVERWRITE_STATE_DIR/agents/main/agent/auth-profiles.json"
FIRST_CODEX_AUTH_JSON='{"version":1,"profiles":{"openai-codex:default":{"type":"oauth","provider":"openai-codex","access":"first.payload.sig","refresh":"refresh-1","expires":1774266149122,"accountId":"acct-first"}}}'
SECOND_CODEX_AUTH_JSON='{"version":1,"profiles":{"openai-codex:default":{"type":"oauth","provider":"openai-codex","access":"second.payload.sig","refresh":"refresh-2","expires":1774269999999,"accountId":"acct-second"}}}'
run_seed_state "$RUNTIME_REPO" "$OVERWRITE_STATE_DIR" set "$FIRST_CODEX_AUTH_JSON"
run_seed_state "$RUNTIME_REPO" "$OVERWRITE_STATE_DIR" set "$SECOND_CODEX_AUTH_JSON"
test -f "$OVERWRITE_AUTH_FILE"
test "$(get_file_mode "$OVERWRITE_AUTH_FILE")" = "600"
jq -e '
  .profiles["openai-codex:default"].accountId == "acct-second" and
  .profiles["openai-codex:default"].refresh == "refresh-2"
' "$OVERWRITE_AUTH_FILE" >/dev/null

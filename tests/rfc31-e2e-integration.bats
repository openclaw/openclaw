#!/usr/bin/env bats

# RFC #31 End-to-End Integration Tests
# Verifies the complete pipeline: lockfile → bindings → middleware → audit log

FIXTURES_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/fixtures/rfc31-e2e" && pwd)"
SCRIPTS_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../scripts" && pwd)"
PYTHON="python3"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

setup() {
    # Create temp directory for each test
    TEST_DIR="$(mktemp -d)"
    cp "$FIXTURES_DIR/sample-lockfile.toml" "$TEST_DIR/agents.lock.toml"
    cp "$FIXTURES_DIR/sample-config.json" "$TEST_DIR/openclaw.json"
    cp "$FIXTURES_DIR/test-messages.json" "$TEST_DIR/test-messages.json"
    AUDIT_LOG="$TEST_DIR/audit.jsonl"
}

teardown() {
    rm -rf "$TEST_DIR"
}

# Read a named test message from test-messages.json
# Usage: get_message <name>
get_message() {
    local name="$1"
    python3 -c "
import json, sys
msgs = json.load(open('$TEST_DIR/test-messages.json'))
for m in msgs:
    if m['name'] == '$name':
        print(json.dumps(m))
        sys.exit(0)
print('{}', file=sys.stderr)
sys.exit(1)
"
}

# Run the middleware and capture output
# Usage: run_middleware <message_json> [extra args...]
run_middleware() {
    local msg="$1"
    shift
    echo "$msg" | python3 "$SCRIPTS_DIR/discord-middleware.py" \
        --lockfile "$TEST_DIR/agents.lock.toml" \
        --audit-log "$AUDIT_LOG" \
        "$@"
}

# ---------------------------------------------------------------------------
# 1. Lockfile → bindings pipeline
# ---------------------------------------------------------------------------

@test "lockfile→bindings: generate-bindings produces correct bindings from lockfile" {
    run "$PYTHON" "$SCRIPTS_DIR/generate-bindings-from-lockfile.py" \
        --lockfile "$TEST_DIR/agents.lock.toml" \
        --config "$TEST_DIR/openclaw.json" \
        --dry-run
    [ "$status" -eq 0 ]

    # Verify output contains bindings for agents with allowed_channels
    [[ "$output" == *"agent_alpha"* ]]
    [[ "$output" == *"agent_beta"* ]]
    [[ "$output" == *"agent_delta"* ]]

    # Verify channel IDs appear in bindings
    [[ "$output" == *"1234567890"* ]]
    [[ "$output" == *"9876543210"* ]]
}

@test "lockfile→bindings: config file is actually written when not dry-run" {
    run "$PYTHON" "$SCRIPTS_DIR/generate-bindings-from-lockfile.py" \
        --lockfile "$TEST_DIR/agents.lock.toml" \
        --config "$TEST_DIR/openclaw.json"
    [ "$status" -eq 0 ]

    # Config file should now contain bindings
    run cat "$TEST_DIR/openclaw.json"
    [[ "$output" == *"bindings"* ]]
    [[ "$output" == *"agent_alpha"* ]]
}

@test "lockfile→bindings: missing lockfile produces warning, not error" {
    rm "$TEST_DIR/agents.lock.toml"
    run "$PYTHON" "$SCRIPTS_DIR/generate-bindings-from-lockfile.py" \
        --lockfile "$TEST_DIR/nonexistent.toml" \
        --config "$TEST_DIR/openclaw.json" \
        --dry-run
    [ "$status" -eq 0 ]
}

@test "lockfile→bindings: invalid TOML lockfile returns error" {
    echo "this is not valid TOML [[[" > "$TEST_DIR/bad.lockfile"
    run "$PYTHON" "$SCRIPTS_DIR/generate-bindings-from-lockfile.py" \
        --lockfile "$TEST_DIR/bad.lockfile" \
        --config "$TEST_DIR/openclaw.json" \
        --dry-run
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# 2. Bridge syntax end-to-end
# ---------------------------------------------------------------------------

@test "bridge syntax: @alpha ask @beta routes to beta" {
    local msg
    msg=$(get_message "bridge_syntax_basic")
    run run_middleware "$msg"
    [ "$status" -eq 0 ]

    # Should route to agent_beta
    [[ "$output" == *'"target_agent": "agent_beta"'* ]]
    [[ "$output" == *'"action": "forward"'* ]]

    # Bridge info should be present
    [[ "$output" == *'"source_agent": "alpha"'* ]]
    [[ "$output" == *'"target_agent": "beta"'* ]]
    [[ "$output" == *'"question": "hello world"'* ]]
}

@test "bridge syntax: @alpha asks @beta routes to beta (alternate tense)" {
    local msg
    msg=$(get_message "bridge_syntax_asks")
    run run_middleware "$msg"
    [ "$status" -eq 0 ]

    [[ "$output" == *'"target_agent": "agent_beta"'* ]]
    [[ "$output" == *'"action": "forward"'* ]]
}

@test "bridge syntax: unknown target agent reports error" {
    run run_middleware '{"content": "@alpha ask @unknown_agent test", "channel_id": "1234567890", "author_id": "user", "message_id": "msg_err"}'
    [ "$status" -eq 0 ]

    # Should have an error about unknown target
    [[ "$output" == *"not found"* ]]
}

# ---------------------------------------------------------------------------
# 3. Channel pinning end-to-end
# ---------------------------------------------------------------------------

@test "channel pinning: allowed channel passes in dry-run" {
    local msg
    msg=$(get_message "channel_allowed")
    run run_middleware "$msg"
    [ "$status" -eq 0 ]

    [[ "$output" == *'"action": "forward"'* ]]
    [[ "$output" == *'"blocked": false'* ]]
}

@test "channel pinning: non-allowed channel logs violation in dry-run" {
    local msg
    msg=$(get_message "channel_blocked")
    run run_middleware "$msg"
    [ "$status" -eq 0 ]

    # Dry-run: logs violation but doesn't block
    [[ "$output" == *'"blocked": false'* ]]
    [[ "$output" == *"not in allowed_channels"* ]]
}

@test "channel pinning: non-allowed channel blocks in enforce mode" {
    local msg
    msg=$(get_message "channel_blocked")
    run run_middleware "$msg" --enforce
    [ "$status" -eq 0 ]

    [[ "$output" == *'"action": "blocked"'* ]]
    [[ "$output" == *'"blocked": true'* ]]
}

@test "channel pinning: no restrictions means always allowed" {
    # agent_gamma has empty allowed_channels
    run run_middleware '{"content": "@gamma say hi", "channel_id": "1111111111", "author_id": "user", "message_id": "msg_chan_free"}'
    [ "$status" -eq 0 ]

    [[ "$output" == *'"action": "forward"'* ]]
    [[ "$output" == *'"blocked": false'* ]]
}

# ---------------------------------------------------------------------------
# 4. Quarantine end-to-end
# ---------------------------------------------------------------------------

@test "quarantine: non-quarantined agent passes" {
    run run_middleware '{"content": "@alpha test", "channel_id": "1234567890", "author_id": "user", "message_id": "msg_q_001"}'
    [ "$status" -eq 0 ]

    [[ "$output" == *'"quarantined": false'* ]]
    [[ "$output" == *'"action": "forward"'* ]]
}

@test "quarantine: quarantined agent is blocked" {
    run run_middleware '{"content": "@alpha test", "channel_id": "1234567890", "author_id": "user", "message_id": "msg_q_002"}' \
        --quarantine agent_alpha
    [ "$status" -eq 0 ]

    [[ "$output" == *'"quarantined": true'* ]]
    [[ "$output" == *'"action": "blocked"'* ]]
    [[ "$output" == *"stale deploy"* ]]
}

@test "quarantine: quarantine only affects the specified agent" {
    # agent_alpha is quarantined, agent_beta should be fine
    run run_middleware '{"content": "@beta test", "channel_id": "1234567890", "author_id": "user", "message_id": "msg_q_003"}' \
        --quarantine agent_alpha
    [ "$status" -eq 0 ]

    [[ "$output" == *'"target_agent": "agent_beta"'* ]]
    [[ "$output" == *'"quarantined": false'* ]]
    [[ "$output" == *'"action": "forward"'* ]]
}

# ---------------------------------------------------------------------------
# 5. Canary routing end-to-end
# ---------------------------------------------------------------------------

@test "canary routing: approximately 10% of messages route to canary" {
    local canary_count=0
    local total=100

    # Use agent_delta (a canary agent) so the canary check actually fires
    for i in $(seq 1 $total); do
        local output
        output=$(echo "{\"content\": \"@delta task $i\", \"channel_id\": \"1234567890\", \"author_id\": \"user\", \"message_id\": \"msg_canary_$i\"}" \
            | python3 "$SCRIPTS_DIR/discord-middleware.py" \
                --lockfile "$TEST_DIR/agents.lock.toml" \
                --audit-log "$AUDIT_LOG" \
                --canary-agents agent_delta \
                --canary-percentage 0.10 2>/dev/null)

        if echo "$output" | grep -q '"canary_routed": true'; then
            canary_count=$((canary_count + 1))
        fi
    done

    # Allow 5-25% range (expected ~10%)
    [ "$canary_count" -ge 5 ]
    [ "$canary_count" -le 25 ]
}

@test "canary routing: bucket value is deterministic for same message_id" {
    local msg1 msg2
    msg1=$(echo '{"content": "@alpha test", "channel_id": "1234567890", "author_id": "user", "message_id": "deterministic_msg"}' \
        | python3 "$SCRIPTS_DIR/discord-middleware.py" \
            --lockfile "$TEST_DIR/agents.lock.toml" \
            --audit-log "$AUDIT_LOG" \
            --canary-agents agent_delta 2>/dev/null)

    msg2=$(echo '{"content": "@alpha test", "channel_id": "1234567890", "author_id": "user", "message_id": "deterministic_msg"}' \
        | python3 "$SCRIPTS_DIR/discord-middleware.py" \
            --lockfile "$TEST_DIR/agents.lock.toml" \
            --audit-log "$AUDIT_LOG" \
            --canary-agents agent_delta 2>/dev/null)

    # Extract bucket values — should be identical
    local bucket1 bucket2
    bucket1=$(echo "$msg1" | python3 -c "import json,sys; print(json.load(sys.stdin)['canary']['bucket'])")
    bucket2=$(echo "$msg2" | python3 -c "import json,sys; print(json.load(sys.stdin)['canary']['bucket'])")

    [ "$bucket1" -eq "$bucket2" ]
}

# ---------------------------------------------------------------------------
# 6. Audit log end-to-end
# ---------------------------------------------------------------------------

@test "audit log: bridge call writes structured JSON entry" {
    local msg
    msg=$(get_message "bridge_syntax_basic")
    run run_middleware "$msg"
    [ "$status" -eq 0 ]

    # Audit log file should exist
    [ -f "$AUDIT_LOG" ]

    # Should contain at least one line
    local line_count
    line_count=$(wc -l < "$AUDIT_LOG")
    [ "$line_count" -ge 1 ]

    # Verify the entry has all required fields
    run python3 -c "
import json, sys
with open('$AUDIT_LOG') as f:
    entry = json.loads(f.readline())
required = ['from_agent', 'to_agent', 'contract_version', 'capability', 'channel_id', 'timestamp']
for field in required:
    if field not in entry:
        print(f'Missing field: {field}', file=sys.stderr)
        sys.exit(1)
# Verify bridge source is present for bridge calls
if entry.get('bridge_source') != 'alpha':
    print(f'Expected bridge_source alpha, got {entry.get(\"bridge_source\")}', file=sys.stderr)
    sys.exit(1)
print('OK')
"
    [ "$status" -eq 0 ]
}

@test "audit log: multiple calls accumulate entries" {
    local msg1 msg2
    msg1='{"content": "@alpha test1", "channel_id": "1234567890", "author_id": "user", "message_id": "audit_msg_1"}'
    msg2='{"content": "@beta test2", "channel_id": "1234567890", "author_id": "user", "message_id": "audit_msg_2"}'

    run_middleware "$msg1" > /dev/null
    run_middleware "$msg2" > /dev/null

    local line_count
    line_count=$(wc -l < "$AUDIT_LOG")
    [ "$line_count" -ge 2 ]
}

@test "audit log: entry contains contract_version" {
    local msg
    msg='{"content": "@alpha test", "channel_id": "1234567890", "author_id": "user", "message_id": "audit_contract_msg"}'
    run run_middleware "$msg"
    [ "$status" -eq 0 ]

    run grep -q "rfc-31-v1" "$AUDIT_LOG"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# 7. Full pipeline
# ---------------------------------------------------------------------------

@test "full pipeline: lockfile → generate bindings → middleware → audit log" {
    # Step 1: Generate bindings from lockfile
    run "$PYTHON" "$SCRIPTS_DIR/generate-bindings-from-lockfile.py" \
        --lockfile "$TEST_DIR/agents.lock.toml" \
        --config "$TEST_DIR/openclaw.json"
    [ "$status" -eq 0 ]

    # Step 2: Verify config has bindings
    run python3 -c "
import json
with open('$TEST_DIR/openclaw.json') as f:
    cfg = json.load(f)
assert 'bindings' in cfg, 'No bindings in config'
assert len(cfg['bindings']) > 0, 'Bindings list is empty'
agent_ids = {b['agentId'] for b in cfg['bindings']}
assert 'agent_alpha' in agent_ids, f'agent_alpha not in bindings: {agent_ids}'
assert 'agent_beta' in agent_ids, f'agent_beta not in bindings: {agent_ids}'
print('Bindings OK')
"
    [ "$status" -eq 0 ]

    # Step 3: Run middleware with a bridge call
    local msg
    msg='{"content": "@alpha ask @beta review my code", "channel_id": "1234567890", "author_id": "user", "message_id": "pipeline_full_001"}'
    run run_middleware "$msg"
    [ "$status" -eq 0 ]

    # Step 4: Verify routing decision
    [[ "$output" == *'"target_agent": "agent_beta"'* ]]
    [[ "$output" == *'"action": "forward"'* ]]

    # Step 5: Verify audit log was written
    [ -f "$AUDIT_LOG" ]
    local line_count
    line_count=$(wc -l < "$AUDIT_LOG")
    [ "$line_count" -ge 1 ]

    # Step 6: Verify audit entry consistency
    run python3 -c "
import json
with open('$AUDIT_LOG') as f:
    entry = json.loads(f.readline())
assert entry['from_agent'] == 'agent_alpha', f'Wrong from_agent: {entry[\"from_agent\"]}'
assert entry['to_agent'] == 'agent_beta', f'Wrong to_agent: {entry[\"to_agent\"]}'
assert entry['contract_version'] == 'rfc-31-v1'
assert entry['channel_id'] == '1234567890'
assert entry['bridge_source'] == 'alpha'
print('Audit entry consistent')
"
    [ "$status" -eq 0 ]
}

@test "full pipeline: channel violation → dry-run logs → enforce blocks" {
    # Step 1: Dry-run — should log but not block
    local msg='{"content": "@beta work on task", "channel_id": "9999999999", "author_id": "user", "message_id": "pipeline_violation_001"}'

    run run_middleware "$msg"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"action": "forward"'* ]]
    [[ "$output" == *"not in allowed_channels"* ]]

    # Step 2: Enforce — should block
    run run_middleware "$msg" --enforce
    [ "$status" -eq 0 ]
    [[ "$output" == *'"action": "blocked"'* ]]
    [[ "$output" == *'"blocked": true'* ]]
}

@test "full pipeline: quarantine blocks even from allowed channel" {
    local msg='{"content": "@alpha do task", "channel_id": "1234567890", "author_id": "user", "message_id": "pipeline_quarantine_001"}'

    # Quarantine agent_alpha
    run run_middleware "$msg" --quarantine agent_alpha
    [ "$status" -eq 0 ]
    [[ "$output" == *'"action": "blocked"'* ]]
    [[ "$output" == *"stale deploy"* ]]
}

@test "full pipeline: capability dispatch routes to correct agent" {
    local msg
    msg='{"content": "run @code analysis", "channel_id": "1234567890", "author_id": "user", "message_id": "pipeline_cap_001"}'
    run run_middleware "$msg"
    [ "$status" -eq 0 ]

    # @code is a capability of agent_beta
    [[ "$output" == *'"target_agent": "agent_beta"'* ]]
    [[ "$output" == *'"action": "forward"'* ]]
}

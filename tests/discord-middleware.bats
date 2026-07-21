#!/usr/bin/env bats

# Tests for scripts/discord-middleware.py
# Discord message middleware for bridge syntax + capabilities (RFC #31)

SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
MIDDLEWARE="$SCRIPT_DIR/scripts/discord-middleware.py"
TEST_DIR="$(mktemp -d)"
LOCKFILE="$TEST_DIR/agents.lock.toml"
AUDIT_LOG="$TEST_DIR/audit.jsonl"

setup() {
    # Create a test lockfile
    cat > "$LOCKFILE" << 'EOF'
[agents.linux_desktop_seed]
handle = "linux-desktop-seed"
allowed_channels = ["1492701850217218268"]
role = "operator"
capabilities = ["coding", "infra"]

[agents.darojaai_architect]
handle = "darojaai-architect"
allowed_channels = ["1234567890"]
role = "architect"
capabilities = ["design"]

[agents.unrestricted_bot]
handle = "unrestricted-bot"
role = "helper"
capabilities = ["general"]
EOF

    # Remove stale audit log
    rm -f "$AUDIT_LOG"
}

teardown() {
    rm -rf "$TEST_DIR"
}

# ---------------------------------------------------------------------------
# Bridge syntax detection
# ---------------------------------------------------------------------------

@test "bridge syntax: @A ask @B routes to B" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@linux-desktop-seed ask @darojaai-architect what is the architecture?", "channel_id": "1234567890", "author_id": "user1", "message_id": "msg1"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    # Target agent should be darojaai_architect (TOML key uses underscore)
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['target_agent']=='darojaai_architect', f'got {d[\"target_agent\"]}'"

    # Bridge metadata should be present
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['bridge'] is not None; assert d['bridge']['target_agent']=='darojaai-architect'; assert d['bridge']['question']=='what is the architecture?'"
}

@test "bridge syntax: @A asks @B (plural) also works" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@linux-desktop-seed asks @unrestricted-bot hello there", "channel_id": "1492701850217218268", "author_id": "user1", "message_id": "msg2"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['target_agent']=='unrestricted_bot', f'got {d[\"target_agent\"]}'"
}

@test "bridge syntax: no match returns no bridge" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "just a regular message", "channel_id": "1234567890", "author_id": "user1", "message_id": "msg3"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['bridge'] is None"
}

# ---------------------------------------------------------------------------
# @handle routing
# ---------------------------------------------------------------------------

@test "handle routing: resolves @linux-desktop-seed" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "hey @linux-desktop-seed can you help?", "channel_id": "1492701850217218268", "author_id": "user1", "message_id": "msg4"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['target_agent']=='linux_desktop_seed', f'got {d[\"target_agent\"]}'"
}

@test "handle routing: resolves @darojaai-architect" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@darojaai-architect please review", "channel_id": "1234567890", "author_id": "user2", "message_id": "msg5"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['target_agent']=='darojaai_architect', f'got {d[\"target_agent\"]}'"
}

@test "handle routing: unknown handle produces no target" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@unknown-agent please help", "channel_id": "1234567890", "author_id": "user1", "message_id": "msg6"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['target_agent'] is None, f'got {d[\"target_agent\"]}'"
}

# ---------------------------------------------------------------------------
# Capability dispatch
# ---------------------------------------------------------------------------

@test "capability dispatch: @coding resolves to agent with coding capability" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@coding please run tests", "channel_id": "1492701850217218268", "author_id": "user1", "message_id": "msg7"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    # Should resolve to linux_desktop_seed which has "coding" capability
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['target_agent']=='linux_desktop_seed', f'got {d[\"target_agent\"]}'"
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert len(d['capability_refs'])>0; assert d['capability_refs'][0]['capability']=='coding'"
}

@test "capability dispatch: @design resolves to architect agent" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@design the new feature", "channel_id": "1234567890", "author_id": "user2", "message_id": "msg8"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['target_agent']=='darojaai_architect', f'got {d[\"target_agent\"]}'"
}

# ---------------------------------------------------------------------------
# Channel pinning: dry-run mode (default)
# ---------------------------------------------------------------------------

@test "channel pinning dry-run: logs violation but does not block" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@linux-desktop-seed help me", "channel_id": "9999999999", "author_id": "user1", "message_id": "msg9"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    # Should NOT be blocked in dry-run mode
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['action']!='blocked', f'got action={d[\"action\"]}'"
    # But channel_check should show violation
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['channel_check'] is not None; assert d['channel_check']['allowed']==False"
}

@test "channel pinning dry-run: allowed channel passes" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@linux-desktop-seed help me", "channel_id": "1492701850217218268", "author_id": "user1", "message_id": "msg10"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['channel_check'] is not None; assert d['channel_check']['allowed']==True; assert d['channel_check']['blocked']==False"
}

# ---------------------------------------------------------------------------
# Channel pinning: enforce mode
# ---------------------------------------------------------------------------

@test "channel pinning enforce: blocks non-allowed channel" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --enforce \
        --message '{"content": "@linux-desktop-seed help me", "channel_id": "9999999999", "author_id": "user1", "message_id": "msg11"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['action']=='blocked', f'got action={d[\"action\"]}'"
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['channel_check']['blocked']==True"
}

@test "channel pinning enforce: allows correct channel" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --enforce \
        --message '{"content": "@linux-desktop-seed help me", "channel_id": "1492701850217218268", "author_id": "user1", "message_id": "msg12"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['action']!='blocked', f'got action={d[\"action\"]}'"
}

# ---------------------------------------------------------------------------
# Quarantine check
# ---------------------------------------------------------------------------

@test "quarantine: blocks quarantined agent" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --quarantine darojaai_architect \
        --message '{"content": "@darojaai-architect review this", "channel_id": "1234567890", "author_id": "user2", "message_id": "msg13"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['action']=='blocked', f'got action={d[\"action\"]}'"
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['quarantine'] is not None; assert d['quarantine']['quarantined']==True"
}

@test "quarantine: passes non-quarantined agent" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --quarantine darojaai_architect \
        --message '{"content": "@linux-desktop-seed help", "channel_id": "1492701850217218268", "author_id": "user1", "message_id": "msg14"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['action']!='blocked', f'got action={d[\"action\"]}'"
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['quarantine']['quarantined']==False"
}

# ---------------------------------------------------------------------------
# Canary routing
# ---------------------------------------------------------------------------

@test "canary routing: deterministic hash-based routing" {
    # Use a message_id that deterministically lands in canary bucket
    # SHA256 of "canary-test-msg" → check first 8 hex chars → bucket
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --canary-agents linux_desktop_seed \
        --canary-percentage 1.0 \
        --message '{"content": "@linux-desktop-seed help", "channel_id": "1492701850217218268", "author_id": "user1", "message_id": "canary-test-msg"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    # With 100% canary, should always canary-route
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['canary'] is not None; assert d['canary']['canary_routed']==True"
}

@test "canary routing: 0% never canary-routes" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --canary-agents linux_desktop_seed \
        --canary-percentage 0.0 \
        --message '{"content": "@linux-desktop-seed help", "channel_id": "1492701850217218268", "author_id": "user1", "message_id": "canary-test-msg"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['canary'] is not None; assert d['canary']['canary_routed']==False"
}

# ---------------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------------

@test "audit log: entry is written for routed messages" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@linux-desktop-seed help", "channel_id": "1492701850217218268", "author_id": "user1", "message_id": "msg15"}'

    [ "$status" -eq 0 ]

    # Audit log file should exist and have content
    [ -f "$AUDIT_LOG" ]
    run cat "$AUDIT_LOG"
    [ "$status" -eq 0 ]

    # Parse the JSONL entry
    echo "$output" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    assert d['to_agent'] == 'linux_desktop_seed', f'got to_agent={d[\"to_agent\"]}'
    assert d['channel_id'] == '1492701850217218268'
    assert d['contract_version'] == 'rfc-31-v1'
    assert 'timestamp' in d
"
}

@test "audit log: bridge source is captured" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@linux-desktop-seed ask @darojaai_architect review PR #42", "channel_id": "1234567890", "author_id": "user1", "message_id": "msg16"}'

    [ "$status" -eq 0 ]

    [ -f "$AUDIT_LOG" ]
    run cat "$AUDIT_LOG"

    echo "$output" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    assert d['from_agent'] == 'linux_desktop_seed'
    assert d['to_agent'] == 'darojaai_architect'
    assert d['bridge_source'] == 'linux-desktop-seed'
    assert d['question'] == 'review PR #42'
"
}

# ---------------------------------------------------------------------------
# Missing lockfile
# ---------------------------------------------------------------------------

@test "missing lockfile: no crash, produces result with errors" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$TEST_DIR/nonexistent.lock.toml" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@someone help", "channel_id": "123", "author_id": "u1", "message_id": "m1"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    # Should not crash — target_agent is None because no registry
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['target_agent'] is None"
}

# ---------------------------------------------------------------------------
# --dry-run is default
# ---------------------------------------------------------------------------

@test "default mode is dry-run (no --enforce flag)" {
    # Use a bad channel without --enforce — should not block
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --message '{"content": "@linux-desktop-seed help", "channel_id": "9999999999", "author_id": "user1", "message_id": "msg17"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    # In dry-run, action should NOT be "blocked"
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['action']!='blocked', f'got action={d[\"action\"]} in default mode'"
}

# ---------------------------------------------------------------------------
# Unrestricted agent (no allowed_channels) — channel check passes
# ---------------------------------------------------------------------------

@test "unrestricted agent: no channel pinning applied" {
    run python3 "$MIDDLEWARE" \
        --lockfile "$LOCKFILE" \
        --audit-log "$AUDIT_LOG" \
        --enforce \
        --message '{"content": "@unrestricted-bot hello", "channel_id": "any-channel", "author_id": "user1", "message_id": "msg18"}'

    [ "$status" -eq 0 ]
    result="$(cat <<< "$output")"

    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['action']!='blocked', f'got action={d[\"action\"]}'"
    echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['channel_check']['allowed']==True"
}

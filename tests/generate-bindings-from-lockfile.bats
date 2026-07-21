#!/usr/bin/env bats

# Tests for scripts/generate-bindings-from-lockfile.py

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts/generate-bindings-from-lockfile.py"
FIXTURES="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/test/fixtures/generate-bindings"

setup() {
  # Create a temp dir for each test
  TEST_DIR="$(mktemp -d)"
  cp "$SCRIPT" "$TEST_DIR/script.py"
}

teardown() {
  rm -rf "$TEST_DIR"
}

# ---------------------------------------------------------------------------
# Helper: write a lockfile and config, run the script, inspect output
# ---------------------------------------------------------------------------

write_lockfile() {
  cat > "$TEST_DIR/agents.lock.toml"
}

write_config() {
  cat > "$TEST_DIR/openclaw.json"
}

run_script() {
  python3 "$TEST_DIR/script.py" --lockfile "$TEST_DIR/agents.lock.toml" --config "$TEST_DIR/openclaw.json" "$@"
}

# ---------------------------------------------------------------------------
# Test: basic single-agent, single-channel binding generation
# ---------------------------------------------------------------------------
@test "generates a single binding from a lockfile with one agent and one channel" {
  write_lockfile <<'TOML'
[agents.my_bot]
handle = "my-bot"
allowed_channels = ["111222333"]
role = "operator"
capabilities = ["coding"]
TOML

  write_config <<'JSON'
{
  "version": 1
}
JSON

  run run_script
  [ "$status" -eq 0 ]

  # Verify the output file has the binding
  run cat "$TEST_DIR/openclaw.json"
  [[ "$output" == *'"agentId": "my_bot"'* ]]
  [[ "$output" == *'"id": "111222333"'* ]]
  [[ "$output" == *'"channel": "discord"'* ]]
}

# ---------------------------------------------------------------------------
# Test: multiple channels produce multiple bindings
# ---------------------------------------------------------------------------
@test "multiple channels per agent produce multiple bindings" {
  write_lockfile <<'TOML'
[agents.my_bot]
handle = "my-bot"
allowed_channels = ["111111", "222222", "333333"]
role = "operator"
capabilities = ["coding"]
TOML

  write_config <<'JSON'
{
  "version": 1
}
JSON

  run run_script
  [ "$status" -eq 0 ]

  run cat "$TEST_DIR/openclaw.json"
  [[ "$output" == *'"id": "111111"'* ]]
  [[ "$output" == *'"id": "222222"'* ]]
  [[ "$output" == *'"id": "333333"'* ]]
}

# ---------------------------------------------------------------------------
# Test: existing non-lockfile bindings are preserved
# ---------------------------------------------------------------------------
@test "existing bindings not in lockfile are preserved" {
  write_lockfile <<'TOML'
[agents.new_bot]
handle = "new-bot"
allowed_channels = ["999999"]
role = "operator"
capabilities = ["chat"]
TOML

  write_config <<'JSON'
{
  "bindings": [
    {
      "agentId": "old_manual_bot",
      "match": {
        "channel": "discord",
        "peer": { "id": "123456" }
      }
    }
  ]
}
JSON

  run run_script
  [ "$status" -eq 0 ]

  run cat "$TEST_DIR/openclaw.json"
  # Old binding preserved
  [[ "$output" == *'"agentId": "old_manual_bot"'* ]]
  # New binding added
  [[ "$output" == *'"agentId": "new_bot"'* ]]
  [[ "$output" == *'"id": "999999"'* ]]
}

# ---------------------------------------------------------------------------
# Test: lockfile bindings replace existing bindings for the same agentId
# ---------------------------------------------------------------------------
@test "lockfile bindings replace existing bindings for the same agentId" {
  write_lockfile <<'TOML'
[agents.my_bot]
handle = "my-bot"
allowed_channels = ["777777"]
role = "operator"
capabilities = ["coding"]
TOML

  write_config <<'JSON'
{
  "bindings": [
    {
      "agentId": "my_bot",
      "match": {
        "channel": "discord",
        "peer": { "id": "111111" }
      }
    },
    {
      "agentId": "my_bot",
      "match": {
        "channel": "discord",
        "peer": { "id": "222222" }
      }
    }
  ]
}
JSON

  run run_script
  [ "$status" -eq 0 ]

  run cat "$TEST_DIR/openclaw.json"
  # Old channels removed
  [[ "$output" != *'"id": "111111"'* ]]
  [[ "$output" != *'"id": "222222"'* ]]
  # New channel present
  [[ "$output" == *'"id": "777777"'* ]]
}

# ---------------------------------------------------------------------------
# Test: multiple agents in lockfile
# ---------------------------------------------------------------------------
@test "handles multiple agents in lockfile" {
  write_lockfile <<'TOML'
[agents.bot_alpha]
handle = "alpha"
allowed_channels = ["100"]
role = "operator"
capabilities = ["coding"]

[agents.bot_beta]
handle = "beta"
allowed_channels = ["200", "300"]
role = "architect"
capabilities = ["design"]
TOML

  write_config <<'JSON'
{
  "version": 1
}
JSON

  run run_script
  [ "$status" -eq 0 ]

  run cat "$TEST_DIR/openclaw.json"
  [[ "$output" == *'"agentId": "bot_alpha"'* ]]
  [[ "$output" == *'"id": "100"'* ]]
  [[ "$output" == *'"agentId": "bot_beta"'* ]]
  [[ "$output" == *'"id": "200"'* ]]
  [[ "$output" == *'"id": "300"'* ]]
}

# ---------------------------------------------------------------------------
# Test: agent with no allowed_channels is skipped
# ---------------------------------------------------------------------------
@test "agent with no allowed_channels is skipped" {
  write_lockfile <<'TOML'
[agents.silent_bot]
handle = "silent"
role = "observer"
capabilities = ["logging"]
TOML

  write_config <<'JSON'
{
  "version": 1
}
JSON

  run run_script
  [ "$status" -eq 0 ]

  run cat "$TEST_DIR/openclaw.json"
  [[ "$output" != *'"silent_bot"'* ]]
}

# ---------------------------------------------------------------------------
# Test: missing lockfile produces no changes
# ---------------------------------------------------------------------------
@test "missing lockfile produces no changes and exits 0" {
  write_config <<'JSON'
{
  "bindings": [
    {
      "agentId": "existing",
      "match": {
        "channel": "discord",
        "peer": { "id": "123" }
      }
    }
  ]
}
JSON

  # Use a non-existent lockfile path
  run python3 "$TEST_DIR/script.py" --lockfile "$TEST_DIR/nonexistent.lock.toml" --config "$TEST_DIR/openclaw.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no changes made"* ]]

  # Config untouched
  run cat "$TEST_DIR/openclaw.json"
  [[ "$output" == *'"agentId": "existing"'* ]]
}

# ---------------------------------------------------------------------------
# Test: invalid TOML produces clear error
# {{
@test "invalid TOML produces a clear error and non-zero exit" {
  cat > "$TEST_DIR/agents.lock.toml" <<'TOML'
this is not valid TOML {[
  broken
TOML

  write_config <<'JSON'
{
  "version": 1
}
JSON

  run python3 "$TEST_DIR/script.py" --lockfile "$TEST_DIR/agents.lock.toml" --config "$TEST_DIR/openclaw.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"error"* ]]
}

# ---------------------------------------------------------------------------
# Test: --dry-run prints to stdout without writing
# ---------------------------------------------------------------------------
@test "--dry-run prints output to stdout without writing to file" {
  write_lockfile <<'TOML'
[agents.dry_bot]
handle = "dry"
allowed_channels = ["555555"]
role = "operator"
capabilities = ["test"]
TOML

  write_config <<'JSON'
{
  "version": 1
}
JSON

  run run_script --dry-run
  [ "$status" -eq 0 ]

  # stdout should contain the binding
  [[ "$output" == *'"agentId": "dry_bot"'* ]]
  [[ "$output" == *'"id": "555555"'* ]]

  # Original file should be unchanged
  run cat "$TEST_DIR/openclaw.json"
  [[ "$output" == *'"version": 1'* ]]
  [[ "$output" != *'"dry_bot"'* ]]
}

# ---------------------------------------------------------------------------
# Test: preserves other config keys
# ---------------------------------------------------------------------------
@test "preserves other top-level config keys" {
  write_lockfile <<'TOML'
[agents.test_bot]
handle = "test"
allowed_channels = ["42"]
role = "operator"
capabilities = ["chat"]
TOML

  write_config <<'JSON'
{
  "version": 2,
  "gateway": { "port": 3000 },
  "agents": {
    "defaults": { "model": "openai/gpt-4" }
  }
}
JSON

  run run_script
  [ "$status" -eq 0 ]

  run cat "$TEST_DIR/openclaw.json"
  [[ "$output" == *'"version": 2'* ]]
  [[ "$output" == *'"port": 3000'* ]]
  [[ "$output" == *'"model": "openai/gpt-4"'* ]]
  [[ "$output" == *'"agentId": "test_bot"'* ]]
}

# ---------------------------------------------------------------------------
# Test: lockfile without agents section produces no bindings
# ---------------------------------------------------------------------------
@test "lockfile without agents section produces no bindings" {
  cat > "$TEST_DIR/agents.lock.toml" <<'TOML'
[metadata]
generated_at = "2026-07-21"
TOML

  write_config <<'JSON'
{
  "bindings": [
    {
      "agentId": "existing",
      "match": { "channel": "discord", "peer": { "id": "123" } }
    }
  ]
}
JSON

  run run_script
  [ "$status" -eq 0 ]

  run cat "$TEST_DIR/openclaw.json"
  # Existing binding preserved
  [[ "$output" == *'"agentId": "existing"'* ]]
}

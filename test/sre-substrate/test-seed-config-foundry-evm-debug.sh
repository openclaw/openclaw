#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"
SKILL="$ROOT/SKILL.md"
SEED_STATE_SCRIPT="$REPO_ROOT/scripts/sre-runtime/seed-state.sh"
RUNTIME_DOCKERFILE="$REPO_ROOT/docker/sre-runtime.Dockerfile"

assert_jq() {
  local message="$1"
  local filter="$2"
  local file="$3"

  jq -e "$filter" "$file" >/dev/null || {
    printf 'FAIL: %s\n' "$message" >&2
    exit 1
  }
}

assert_grep() {
  local message="$1"
  shift

  grep "$@" >/dev/null || {
    printf 'FAIL: %s\n' "$message" >&2
    exit 1
  }
}

assert_jq "sre agent missing foundry-evm-debug skill" '
  any(.agents.list[]; .id == "sre" and ((.skills // []) | index("foundry-evm-debug")))
' "$CONFIG"

assert_jq "sre-release agent missing foundry-evm-debug skill" '
  any(.agents.list[]; .id == "sre-release" and ((.skills // []) | index("foundry-evm-debug")))
' "$CONFIG"

assert_jq "sre-repo-runtime agent missing foundry-evm-debug skill" '
  any(.agents.list[]; .id == "sre-repo-runtime" and ((.skills // []) | index("foundry-evm-debug")))
' "$CONFIG"

assert_jq "sre-verifier agent missing foundry-evm-debug skill" '
  any(.agents.list[]; .id == "sre-verifier" and ((.skills // []) | index("foundry-evm-debug")))
' "$CONFIG"

assert_jq "cast missing from safeBins" '(.tools.exec.safeBins // []) | index("cast")' "$CONFIG"
assert_jq "anvil missing from safeBins" '(.tools.exec.safeBins // []) | index("anvil")' "$CONFIG"
assert_jq "forge missing from safeBins" '(.tools.exec.safeBins // []) | index("forge")' "$CONFIG"
assert_jq "chisel missing from safeBins" '(.tools.exec.safeBins // []) | index("chisel")' "$CONFIG"
assert_jq "safeBinTrustedDirs missing /usr/local/bin" '(.tools.exec.safeBinTrustedDirs // []) | index("/usr/local/bin")' "$CONFIG"

assert_grep "seed skill guide missing foundry-evm-debug reference" -F 'use the bundled `foundry-evm-debug` skill' "$SKILL"
assert_grep "seed-state missing grafana skill copy" -F 'grafana-metrics-best-practices' "$SEED_STATE_SCRIPT"
assert_grep "seed-state missing foundry-evm-debug copy" -F 'foundry-evm-debug' "$SEED_STATE_SCRIPT"
assert_grep "seed-state missing bundled helper skill list" -F 'required_bundled_skills=(' "$SEED_STATE_SCRIPT"
assert_grep "runtime dockerfile missing acpx install" -F 'npm --prefix /usr/local/lib/node_modules/openclaw/extensions/acpx install --omit=dev --no-save "acpx@${ACPX_VERSION}"' "$RUNTIME_DOCKERFILE"
assert_grep "runtime dockerfile missing foundryup" -F '/opt/foundry/bin/foundryup' "$RUNTIME_DOCKERFILE"
# Foundry version is no longer pinned; foundryup installs latest stable at build time.
assert_grep "runtime dockerfile should not pin foundry version" -v -F 'OPENCLAW_FOUNDRY_VERSION' "$RUNTIME_DOCKERFILE"
assert_grep "runtime dockerfile missing forge link" -F 'ln -sf /opt/foundry/bin/forge /usr/local/bin/forge' "$RUNTIME_DOCKERFILE"
assert_grep "runtime dockerfile missing cast link" -F 'ln -sf /opt/foundry/bin/cast /usr/local/bin/cast' "$RUNTIME_DOCKERFILE"
assert_grep "runtime dockerfile missing anvil link" -F 'ln -sf /opt/foundry/bin/anvil /usr/local/bin/anvil' "$RUNTIME_DOCKERFILE"
assert_grep "runtime dockerfile missing chisel link" -F 'ln -sf /opt/foundry/bin/chisel /usr/local/bin/chisel' "$RUNTIME_DOCKERFILE"

printf 'PASS: all foundry-evm-debug runtime substrate assertions passed\n'

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_ROOT="$SCRIPT_DIR/.tmp"

rm -rf "$TMP_ROOT"
mkdir -p "$TMP_ROOT"
trap 'rm -rf "$TMP_ROOT"' EXIT

if command -v pnpm >/dev/null 2>&1 && pnpm --version >/dev/null 2>&1; then
  OPENCLAW_CMD=(pnpm openclaw)
else
  OPENCLAW_CMD=(node --import tsx "$REPO_ROOT/src/entry.ts")
fi

redact_json() {
  node -e '
const fs = require("node:fs");

let body = fs.readFileSync(0, "utf8");
const replacements = [
  [process.argv[1], "$REPO"],
  [process.argv[2], "$TMP_AUDIT_EVIDENCE"],
  [process.env.HOME || "", "$HOME"],
  [process.env.TMPDIR || "", "$TMPDIR"],
].filter(([value]) => value.length > 0);

for (const [value, replacement] of replacements) {
  body = body.split(value).join(replacement);
}

process.stdout.write(body);
' "$REPO_ROOT" "$TMP_ROOT"
}

write_config() {
  local config_path="$1"
  local bind="$2"
  mkdir -p "$(dirname "$config_path")"
  cat >"$config_path" <<JSON
{
  "plugins": {
    "enabled": false
  },
  "gateway": {
    "bind": "$bind",
    "controlUi": {
      "enabled": true
    },
    "auth": {}
  }
}
JSON
}

run_case() {
  local name="$1"
  local bind="$2"
  local node_options="${3:-}"
  local case_dir="$TMP_ROOT/$name"
  local config_path="$case_dir/openclaw.json"
  local output_path="$SCRIPT_DIR/$name.json"

  mkdir -p "$case_dir/home" "$case_dir/state"
  chmod 700 "$case_dir/home" "$case_dir/state"
  write_config "$config_path" "$bind"
  chmod 600 "$config_path"

  (
    cd "$REPO_ROOT"
    env \
      HOME="$case_dir/home" \
      OPENCLAW_HOME="$case_dir/home" \
      OPENCLAW_STATE_DIR="$case_dir/state" \
      OPENCLAW_CONFIG_PATH="$config_path" \
      OPENCLAW_TEST_FAST=1 \
      OPENCLAW_SKIP_CHANNELS=1 \
      OPENCLAW_GATEWAY_TOKEN= \
      OPENCLAW_GATEWAY_PASSWORD= \
      NODE_OPTIONS="$node_options" \
      "${OPENCLAW_CMD[@]}" security audit --json
  ) | redact_json >"$output_path"
}

CONTAINER_PRELOAD="$TMP_ROOT/simulate-container.cjs"
cat >"$CONTAINER_PRELOAD" <<'JS'
const fs = require("node:fs");
const originalExistsSync = fs.existsSync.bind(fs);

fs.existsSync = function existsSyncWithContainerSentinel(filePath, ...args) {
  if (
    filePath === "/.dockerenv" ||
    filePath === "/run/.containerenv" ||
    filePath === "/var/run/.containerenv"
  ) {
    return true;
  }
  return originalExistsSync(filePath, ...args);
};
JS

run_case "loopback-bind" "loopback"
run_case "auto-bind-non-container" "auto"
run_case "auto-bind-resolves-0.0.0.0" "auto" "--require=$CONTAINER_PRELOAD"

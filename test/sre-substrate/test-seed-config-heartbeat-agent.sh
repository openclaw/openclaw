#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"

jq -e '
  .agents.defaults.heartbeat.session == "sentinel-monitor"
' "$CONFIG" >/dev/null

jq -e '
  any(.agents.list[]; .id == "sre" and .heartbeat.session == "sentinel-monitor")
' "$CONFIG" >/dev/null

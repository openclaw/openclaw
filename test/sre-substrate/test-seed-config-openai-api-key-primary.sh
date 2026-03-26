#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"
RCA_CODEX="$ROOT/rca-provider-codex.sh"

jq -e '
  .agents.defaults.model.primary == "openai-codex/gpt-5.4"
' "$CONFIG" >/dev/null

jq -e '
  any(.agents.list[]; .id == "sre" and .model.primary == "anthropic/claude-opus-4-6")
' "$CONFIG" >/dev/null

jq -e '
  .agents.defaults.model.fallbacks | index("anthropic/claude-opus-4-6")
' "$CONFIG" >/dev/null

rg -F 'RCA_PROVIDER_MODEL="${RCA_PROVIDER_MODEL:-openai-codex/gpt-5.4}"' "$RCA_CODEX" >/dev/null

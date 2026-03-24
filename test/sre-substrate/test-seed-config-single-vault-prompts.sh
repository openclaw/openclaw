#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"
PROMPT_LIB="$REPO_ROOT/scripts/sre-runtime/lib-prompts.sh"

PROMPT_TEXT="$(
  OPENCLAW_SRE_SKILL_DIR="/home/node/.openclaw/skills/morpho-sre" \
    bash -lc 'source "$1"; build_monitoring_incident_prompt' _ "$PROMPT_LIB"
)"

printf '%s' "$PROMPT_TEXT" | rg -F 'First few lines should answer: Incident, Customer impact, Affected services, Status.' >/dev/null
printf '%s' "$PROMPT_TEXT" | rg -F 'If new evidence disproves an earlier theory, state that directly in the next update' >/dev/null
printf '%s' "$PROMPT_TEXT" | rg -F 'For one-address GraphQL' >/dev/null
printf '%s' "$PROMPT_TEXT" | rg -F 'single-vault-graphql-evidence.sh when possible' >/dev/null
printf '%s' "$PROMPT_TEXT" | rg -F 'Do not call an ingestion/provenance root cause confirmed for a single-vault GraphQL incident' >/dev/null

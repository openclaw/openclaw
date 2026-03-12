#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
SKILL="$ROOT/SKILL.md"

rg -F '## Agent-Specific Modes' "$SKILL" >/dev/null
rg -F 'agent=sre-k8s' "$SKILL" >/dev/null
rg -F 'agent=sre-observability' "$SKILL" >/dev/null
rg -F 'agent=sre-release' "$SKILL" >/dev/null
rg -F 'agent=sre-repo-runtime' "$SKILL" >/dev/null
rg -F 'agent=sre-repo-helm' "$SKILL" >/dev/null
rg -F 'agent=sre-verifier' "$SKILL" >/dev/null

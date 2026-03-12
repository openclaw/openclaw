#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${REPO_ROOT}/skills/morpho-sre/autofix-pr.sh"

bash "$SCRIPT_PATH" -h >/dev/null

echo "autofix-pr test: PASS"
